import { Request, Response } from 'express'
import { Types } from 'mongoose'
import Crowi from 'server/crowi'
import Debug from 'debug'
import ApiResponse from '../utils/apiResponse'
import { decodeSpace } from '../utils/path'
import { BookmarkDocument } from 'server/models/bookmark'
import { PageDocument } from 'server/models/page'
import { RevisionDocument } from 'server/models/revision'
import { UserDocument } from 'server/models/user'

interface PagerOptions {
  offset: number | string
  limit: number | string
  length?: number
}

export default (crowi: Crowi) => {
  const debug = Debug('crowi:routes:page')
  const Page = crowi.model('Page')
  const User = crowi.model('User')
  const Bookmark = crowi.model('Bookmark')
  const Watcher = crowi.model('Watcher')
  const actions = {} as any
  const api = (actions.api = {} as any)

  // register page events
  const pageEvent = crowi.event('Page')
  pageEvent.on('update', function(page, user) {
    const io = crowi.getIo()
    if (io) {
      io.sockets.emit('page edited', { page, user })
    }
  })

  function getPathFromRequest(req) {
    let path
    path = '/' + (req.params[0] || '')
    path = decodeSpace(path)
    path = path.replace(/\.md$/, '')
    return path
  }

  // TODO: total とかでちゃんと計算する
  function generatePager(options: PagerOptions) {
    let next: number | null = null
    let prev: number | null = null
    const offset = parseInt(String(options.offset), 10)
    const limit = parseInt(String(options.limit), 10)
    const length = options.length || 0

    if (offset > 0) {
      prev = offset - limit
      if (prev < 0) {
        prev = 0
      }
    }

    if (length < limit) {
      next = null
    } else {
      next = offset + limit
    }

    return {
      prev: prev,
      next: next,
      offset: offset,
    }
  }

  // routing
  actions.pageListShow = async function(req: Request, res: Response) {
    const user = req.user as UserDocument
    const limit = 50
    const offset = parseInt(req.query.offset) || 0
    const SEENER_THRESHOLD = 10
    let path = getPathFromRequest(req)
    path = path + (path == '/' ? '' : '/')

    debug('Page list show', path)

    const pagerOptions: PagerOptions = { offset, limit }
    const queryOptions = { offset, limit: limit + 1 }

    try {
      const [portalPage, pageList] = (await Promise.all([
        Page.findPortalPage(path, req.user, req.query.revision),
        Page.findListByStartWith(path, req.user, queryOptions),
        // FIXME: A bug of Promise.all type. It was introduced by TypeScript 3.7.3.
        // https://github.com/microsoft/TypeScript/pull/33707
      ])) as [PageDocument | null, PageDocument[]]

      if (pageList.length > limit) {
        pageList.pop()
      }

      if (portalPage) {
        crowi.lru.add(user._id.toString(), portalPage._id.toString())
      }

      pagerOptions.length = pageList.length
      res.render('page_list.html', {
        path,
        page: portalPage || null,
        pages: pageList,
        pager: generatePager(pagerOptions),
        viewConfig: {
          seener_threshold: SEENER_THRESHOLD,
        },
      })
    } catch (err) {
      debug('Error on rendering pageListShow', err)
    }
  }

  actions.deletedPageListShow = function(req: Request, res: Response) {
    const path = '/trash' + getPathFromRequest(req)
    const limit = 50
    const offset = parseInt(req.query.offset) || 0

    // index page
    const pagerOptions: PagerOptions = { offset, limit }
    const queryOptions = {
      offset,
      limit: limit + 1,
      includeDeletedPage: true,
    }

    const renderVars: any = {
      page: null,
      path,
      pages: [],
    }

    Page.findListByStartWith(path, req.user, queryOptions)
      .then(function(pageList) {
        if (pageList.length > limit) {
          pageList.pop()
        }

        pagerOptions.length = pageList.length

        renderVars.pager = generatePager(pagerOptions)
        renderVars.pages = pageList
        res.render('page_list.html', renderVars)
      })
      .catch(function(err) {
        debug('Error on rendering deletedPageListShow', err)
      })
  }

  async function renderPage(pageData, req: Request, res: Response) {
    const user = req.user as UserDocument

    // create page
    if (!pageData) {
      return res.render('page.html', {
        author: {},
        page: false,
      })
    }

    crowi.lru.add(user._id.toString(), pageData._id.toString())

    if (pageData.redirectTo) {
      return res.redirect(encodeURI(pageData.redirectTo + '?redirectFrom=' + pageData.path))
    }

    const renderVars = {
      path: pageData.path,
      page: pageData,
      revision: pageData.revision || {},
      author: pageData.revision.author || false,
    }
    const defaultPageTeamplate = 'page.html'

    res.render(req.query.presentation ? 'page_presentation.html' : defaultPageTeamplate, renderVars)
  }

  actions.userPageShow = async function(req: Request, res: Response) {
    const user = req.user as UserDocument
    const username = req.params.username
    const path = `/user/${username}`
    res.locals.path = path
    debug('path', path)

    // check page existance
    let pageData
    try {
      pageData = await Page.findPage(path, req.user, req.query.revision)

      crowi.lru.add(user._id.toString(), pageData._id.toString())

      if (pageData.redirectTo) {
        return res.redirect(encodeURI(pageData.redirectTo + '?redirectFrom=' + pageData.path))
      }
    } catch (e) {
      // for B.C.: Old Crowi has no user page
      return renderPage(null, req, res) // show create
    }

    let pageUser: UserDocument | {} | null = {}
    let bookmarkList: BookmarkDocument[] = []
    let createdList = []
    try {
      // user いない場合
      pageUser = await User.findUserByUsername(username)
      ;[bookmarkList, createdList] = await Promise.all([
        Bookmark.findByUser(pageUser, { limit: 10, populatePage: true, requestUser: req.user }),
        Page.findListByCreator(pageUser, { limit: 10 }, req.user),
      ])
    } catch (e) {
      debug('Error while loading user page.', username)
    }

    return res.render('user_page.html', {
      username,
      bookmarkList,
      createdList,
      pageUser,
      path: pageData.path,
      page: pageData,
      revision: pageData.revision || {},
      author: pageData.revision.author || false,
    })
  }

  actions.pageShow = async function(req: Request, res: Response) {
    const path = getPathFromRequest(req)

    // FIXME: せっかく getPathFromRequest になってるのにここが生 params[0] だとダサイ
    const isMarkdown = req.params[0].match(/.+\.md$/) || false

    res.locals.path = path
    try {
      const page = (await Page.findPage(path, req.user, req.query.revision)) as PageDocument
      debug('Page found', page._id, page.path)

      if (isMarkdown) {
        res.set('Content-Type', 'text/plain')
        return res.send(((page.revision as any) as RevisionDocument).body)
      }

      return renderPage(page, req, res)
    } catch (err) {
      const normalizedPath = Page.normalizePath(path)
      if (normalizedPath !== path) {
        return res.redirect(normalizedPath)
      }

      // pageShow は /* にマッチしてる最後の砦なので、creatableName でない routing は
      // これ以前に定義されているはずなので、こうしてしまって問題ない。
      if (!Page.isCreatableName(path)) {
        // 削除済みページの場合 /trash 以下に移動しているので creatableName になっていないので、表示を許可
        debug('Page is not creatable name.', path)
        res.redirect('/')
        return
      }
      if (req.query.revision) {
        return res.redirect(encodeURI(path))
      }

      if (isMarkdown) {
        return res.redirect('/')
      }

      try {
        const portalPage = await Page.hasPortalPage(path + '/', req.user)
        if (portalPage) {
          return res.redirect(encodeURI(path) + '/')
        } else {
          const fixed = Page.fixToCreatableName(path)
          if (fixed !== path) {
            debug('fixed page name', fixed)
            res.redirect(encodeURI(fixed))
            return
          }

          debug('There no page for', `${path}`)
          return renderPage(null, req, res)
        }
      } catch (err) {
        debug('Error on rendering pageShow (redirect to portal)', err)
      }
    }
  }

  actions.pageEdit = function(req: Request, res: Response) {
    const pageForm = req.body.pageForm
    const body = pageForm.body
    const currentRevision = pageForm.currentRevision
    const grant = pageForm.grant
    const path = pageForm.path

    // TODO: make it pluggable
    const notify = pageForm.notify || {}

    debug('notify: ', notify)

    const redirectPath = encodeURI(path)
    let pageData: PageDocument | null | {} = {}
    let updateOrCreate
    let previousRevision: Types.ObjectId | null | false = false

    // set to render
    res.locals.pageForm = pageForm

    // 削除済みページはここで編集不可判定される
    if (!Page.isCreatableName(path)) {
      res.redirect(redirectPath)
      return
    }

    const ignoreNotFound = true
    Page.findPage(path, req.user, null, ignoreNotFound)
      .then(function(data) {
        pageData = data

        if (!req.form.isValid) {
          debug('Form data not valid')
          throw new Error('Form data not valid.')
        }

        if (data && !data.isUpdatable(currentRevision)) {
          debug('Conflict occured')
          req.form.errors.push('page_edit.notice.conflict')
          throw new Error('Conflict.')
        }

        if (data) {
          previousRevision = data.revision
          return Page.updatePage(data, body, req.user, { grant: grant })
        } else {
          // new page
          updateOrCreate = 'create'
          return Page.createPage(path, body, req.user, { grant: grant })
        }
      })
      .then(function(data) {
        // data is a saved page data.
        pageData = data
        if (!data) {
          throw new Error('Data not found')
        }
        // TODO: move to events
        if (notify.slack) {
          if (notify.slack.on && notify.slack.channel) {
            data
              .updateSlackChannel(notify.slack.channel)
              .then(function() {})
              .catch(function() {})

            if (crowi.slack) {
              notify.slack.channel.split(',').map(function(chan) {
                const message = crowi.slack.prepareSlackMessage(pageData, req.user, chan, updateOrCreate, previousRevision)
                crowi.slack
                  .post(message.channel, message.text, message)
                  .then(function() {})
                  .catch(function() {})
              })
            }
          }
        }

        return res.redirect(redirectPath)
      })
      .catch(function(err) {
        debug('Page create or edit error.', err)
        if (pageData && !req.form.isValid) {
          return renderPage(pageData, req, res)
        }

        return res.redirect(redirectPath)
      })
  }

  // app.get( '/users/:username([^/]+)/bookmarks'      , loginRequired(crowi, app) , page.userBookmarkList);
  actions.userBookmarkList = function(req: Request, res: Response) {
    const username = req.params.username
    const limit = 50
    const offset = parseInt(req.query.offset) || 0

    const renderVars: any = {}

    const pagerOptions: PagerOptions = { offset, limit }
    const queryOptions = { offset, limit: limit + 1, populatePage: true, requestUser: req.user }

    User.findUserByUsername(username)
      .then(function(user) {
        if (user === null) {
          throw new Error('The user not found.')
        }
        renderVars.pageUser = user

        return Bookmark.findByUser(user, queryOptions)
      })
      .then(function(bookmarks) {
        if (bookmarks.length > limit) {
          bookmarks.pop()
        }
        pagerOptions.length = bookmarks.length

        renderVars.pager = generatePager(pagerOptions)
        renderVars.bookmarks = bookmarks

        return res.render('user/bookmarks.html', renderVars)
      })
      .catch(function(err) {
        debug('Error on rendereing bookmark', err)
        res.redirect('/')
      })
  }

  // app.get( '/users/:username([^/]+)/recent-create' , loginRequired(crowi, app) , page.userRecentCreatedList);
  actions.userRecentCreatedList = function(req: Request, res: Response) {
    const username = req.params.username
    const limit = 50
    const offset = parseInt(req.query.offset) || 0

    const renderVars: any = {}

    const pagerOptions: PagerOptions = { offset, limit }
    const queryOptions = { offset, limit: limit + 1 }

    User.findUserByUsername(username)
      .then(function(user) {
        if (user === null) {
          throw new Error('The user not found.')
        }
        renderVars.pageUser = user

        return Page.findListByCreator(user, queryOptions, req.user)
      })
      .then(function(pages) {
        if (pages.length > limit) {
          pages.pop()
        }
        pagerOptions.length = pages.length

        renderVars.pager = generatePager(pagerOptions)
        renderVars.pages = pages

        return res.render('user/recent-create.html', renderVars)
      })
      .catch(function(err) {
        debug('Error on rendereing recent-created', err)
        res.redirect('/')
      })
  }

  /**
   * redirector
   */
  api.redirector = function(req: Request, res: Response) {
    const id = req.params.id

    Page.findPageById(id)
      .then(function(pageData) {
        const isGranted = pageData.isGrantedFor(req.user)

        if (pageData.grant == Page.GRANT_RESTRICTED && !isGranted) {
          return Page.pushToGrantedUsers(pageData, req.user)
        }

        if (!isGranted) {
          throw new Error('Page is not granted for the user.')
        }

        return Promise.resolve(pageData)
      })
      .then(function(page) {
        return res.redirect(encodeURI(page.path))
      })
      .catch(function(err) {
        return res.redirect('/')
      })
  }

  /**
   * @api {get} /pages.list List pages by user
   * @apiName ListPage
   * @apiGroup Page
   *
   * @apiParam {String} path
   * @apiParam {String} user
   */
  api.list = function(req: Request, res: Response) {
    const username = req.query.user || null
    const path = req.query.path || null
    const limit = 50
    const offset = parseInt(req.query.offset) || 0

    const pagerOptions: PagerOptions = { offset, limit }
    const queryOptions = { offset, limit: limit + 1 }

    // Accepts only one of these
    if (username === null && path === null) {
      return res.json(ApiResponse.error('Parameter user or path is required.'))
    }
    if (username !== null && path !== null) {
      return res.json(ApiResponse.error('Parameter user or path is required.'))
    }

    let pageFetcher
    if (path === null) {
      pageFetcher = User.findUserByUsername(username).then(function(user) {
        if (user === null) {
          throw new Error('The user not found.')
        }
        return Page.findListByCreator(user, queryOptions, req.user)
      })
    } else {
      pageFetcher = Page.findListByStartWith(path, req.user, queryOptions)
    }

    pageFetcher
      .then(function(pages) {
        if (pages.length > limit) {
          pages.pop()
        }
        pagerOptions.length = pages.length

        const result = { pages }
        return res.json(ApiResponse.success(result))
      })
      .catch(function(err) {
        return res.json(ApiResponse.error(err))
      })
  }

  /**
   * @api {post} /pages.create Create new page
   * @apiName CreatePage
   * @apiGroup Page
   *
   * @apiParam {String} body
   * @apiParam {String} path
   * @apiParam {String} grant
   */
  api.create = function(req: Request, res: Response) {
    const body = req.body.body || null
    const pagePath = req.body.path || null
    const grant = req.body.grant || null

    if (body === null || pagePath === null) {
      return res.json(ApiResponse.error('Parameters body and path are required.'))
    }

    const ignoreNotFound = true
    Page.findPage(pagePath, req.user, null, ignoreNotFound)
      .then(function(data) {
        if (data !== null) {
          throw new Error('Page exists')
        }

        return Page.createPage(pagePath, body, req.user, { grant: grant })
      })
      .then(function(data) {
        if (!data) {
          throw new Error('Failed to create page.')
        }
        const result = { page: data.toObject() }

        return res.json(ApiResponse.success(result))
      })
      .catch(function(err) {
        return res.json(ApiResponse.error(err))
      })
  }

  /**
   * @api {post} /pages.update Update page
   * @apiName UpdatePage
   * @apiGroup Page
   *
   * @apiParam {String} body
   * @apiParam {String} page_id
   * @apiParam {String} revision_id
   * @apiParam {String} grant
   *
   * In the case of the page exists:
   * - If revision_id is specified => update the page,
   * - If revision_id is not specified => force update by the new contents.
   */
  api.update = function(req: Request, res: Response) {
    const pageBody = req.body.body || null
    const pageId = req.body.page_id || null
    const revisionId = req.body.revision_id || null
    const grant = req.body.grant || null

    if (pageId === null || pageBody === null) {
      return res.json(ApiResponse.error('page_id and body are required.'))
    }

    Page.findPageByIdAndGrantedUser(pageId, req.user)
      .then(function(pageData) {
        if (pageData && revisionId !== null && !pageData.isUpdatable(revisionId)) {
          throw new Error('Revision error.')
        }

        const grantOption = { grant: pageData.grant }
        if (grant !== null) {
          grantOption.grant = grant
        }
        return Page.updatePage(pageData, pageBody, req.user, grantOption)
      })
      .then(function(pageData) {
        const result = {
          page: pageData.toObject(),
        }
        return res.json(ApiResponse.success(result))
      })
      .catch(function(err) {
        debug('error on _api/pages.update', err)
        return res.json(ApiResponse.error(err))
      })
  }

  /**
   * @api {get} /pages.get Get page data
   * @apiName GetPage
   * @apiGroup Page
   *
   * @apiParam {String} page_id
   * @apiParam {String} path
   * @apiParam {String} revision_id
   */
  api.get = function(req: Request, res: Response) {
    const pagePath = req.query.path || null
    const pageId = req.query.page_id || null // TODO: handling
    const revisionId = req.query.revision_id || null

    if (!pageId && !pagePath) {
      return res.json(ApiResponse.error(new Error('Parameter path or page_id is required.')))
    }

    let pageFinder
    if (pageId) {
      // prioritized
      pageFinder = Page.findPageByIdAndGrantedUser(pageId, req.user)
    } else if (pagePath) {
      pageFinder = Page.findPage(pagePath, req.user, revisionId)
    }

    pageFinder
      .then(function(page) {
        const result = { page }

        return res.json(ApiResponse.success(result))
      })
      .catch(function(err) {
        return res.json(ApiResponse.error(err))
      })
  }

  /**
   * @api {post} /pages.seen Mark as seen user
   * @apiName SeenPage
   * @apiGroup Page
   *
   * @apiParam {String} page_id Page Id.
   */
  api.seen = function(req: Request, res: Response) {
    const pageId = req.body.page_id
    if (!pageId) {
      return res.json(ApiResponse.error('page_id required'))
    }

    Page.findPageByIdAndGrantedUser(pageId, req.user)
      .then(function(page) {
        return page.seen(req.user)
      })
      .then(function(seenUser) {
        const result = { seenUser }

        return res.json(ApiResponse.success(result))
      })
      .catch(function(err) {
        debug('Seen user update error', err)
        return res.json(ApiResponse.error(err))
      })
  }

  /**
   * @api {post} /likes.add Like page
   * @apiName LikePage
   * @apiGroup Page
   *
   * @apiParam {String} page_id Page Id.
   */
  api.like = function(req: Request, res: Response) {
    const id = req.body.page_id

    Page.findPageByIdAndGrantedUser(id, req.user)
      .then(function(pageData) {
        return pageData.like(req.user)
      })
      .then(function(data) {
        const result = { page: data }
        return res.json(ApiResponse.success(result))
      })
      .catch(function(err) {
        debug('Like failed', err)
        return res.json(ApiResponse.error({}))
      })
  }

  /**
   * @api {post} /likes.remove Unlike page
   * @apiName UnlikePage
   * @apiGroup Page
   *
   * @apiParam {String} page_id Page Id.
   */
  api.unlike = function(req: Request, res: Response) {
    const id = req.body.page_id

    Page.findPageByIdAndGrantedUser(id, req.user)
      .then(function(pageData) {
        return pageData.unlike(req.user)
      })
      .then(function(data) {
        const result = { page: data }
        return res.json(ApiResponse.success(result))
      })
      .catch(function(err) {
        debug('Unlike failed', err)
        return res.json(ApiResponse.error({}))
      })
  }

  /**
   * @api {get} /pages.updatePost
   * @apiName Get UpdatePost setting list
   * @apiGroup Page
   *
   * @apiParam {String} path
   */
  api.getUpdatePost = function(req: Request, res: Response) {
    const path = req.query.path
    const UpdatePost = crowi.model('UpdatePost')

    if (!path) {
      return res.json(ApiResponse.error({}))
    }

    UpdatePost.findSettingsByPath(path)
      .then(function(data) {
        data = data.map(function(e) {
          return e.channel
        })
        debug('Found updatePost data', data)
        const result = { updatePost: data }
        return res.json(ApiResponse.success(result))
      })
      .catch(function(err) {
        debug('Error occured while get setting', err)
        return res.json(ApiResponse.error({}))
      })
  }

  /**
   * @api {post} /pages.remove Remove page
   * @apiName RemovePage
   * @apiGroup Page
   *
   * @apiParam {String} page_id Page Id.
   * @apiParam {String} revision_id
   */
  api.remove = function(req: Request, res: Response) {
    const pageId = req.body.page_id
    const previousRevision = req.body.revision_id || null

    // get completely flag
    const isCompletely = req.body.completely !== undefined

    Page.findPageByIdAndGrantedUser(pageId, req.user)
      .then(function(pageData) {
        debug('Delete page', pageData._id, pageData.path)

        if (isCompletely) {
          return Page.completelyDeletePage(pageData, req.user)
        }

        // else

        if (!pageData.isUpdatable(previousRevision)) {
          throw new Error("Someone could update this page, so couldn't delete.")
        }
        return Page.deletePage(pageData, req.user)
      })
      .then(function(page) {
        debug('Page deleted', page.path)
        const result = { page }

        return res.json(ApiResponse.success(result))
      })
      .catch(function(err) {
        debug('Error occured while get setting', err, err.stack)
        return res.json(ApiResponse.error('Failed to delete page.'))
      })
  }

  /**
   * @api {post} /pages.revertRemove Revert removed page
   * @apiName RevertRemovePage
   * @apiGroup Page
   *
   * @apiParam {String} page_id Page Id.
   */
  api.revertRemove = function(req: Request, res: Response) {
    const pageId = req.body.page_id

    Page.findPageByIdAndGrantedUser(pageId, req.user)
      .then(function(pageData) {
        // TODO: これでいいんだっけ
        return Page.revertDeletedPage(pageData, req.user)
      })
      .then(function(page) {
        debug('Complete to revert deleted page', page.path)
        const result = { page }

        return res.json(ApiResponse.success(result))
      })
      .catch(function(err) {
        debug('Error occured while get setting', err, err.stack)
        return res.json(ApiResponse.error('Failed to revert deleted page.'))
      })
  }

  /**
   * @api {post} /pages.rename Rename page
   * @apiName RenamePage
   * @apiGroup Page
   *
   * @apiParam {String} page_id Page Id.
   * @apiParam {String} path
   * @apiParam {String} revision_id
   * @apiParam {String} new_path
   * @apiParam {Bool} create_redirect
   */
  api.rename = async function(req: Request, res: Response) {
    const { page_id: pageId, revision_id: previousRevision = null, new_path: newPath, create_redirect: createRedirect, move_trees: moveTrees } = req.body
    const newPagePath = Page.normalizePath(newPath)
    const newPageIsPortal = newPagePath.endsWith('/')
    const options = {
      createRedirectPage: (!newPageIsPortal && createRedirect) || 0,
      moveUnderTrees: moveTrees || 0,
    }

    if (!Page.isCreatableName(newPagePath)) {
      return res.json(ApiResponse.error(`このページ名は作成できません (${newPagePath})`))
    }

    const rename = async function() {
      try {
        const page = await Page.findPageById(pageId)
        if (!page.isUpdatable(previousRevision)) {
          return res.json(ApiResponse.error(new Error("Someone could update this page, so couldn't delete.")))
        }
        await Page.rename(page, newPagePath, req.user, options)
        const result = { page }
        return res.json(ApiResponse.success(result))
      } catch (err) {
        return res.json(ApiResponse.error('Failed to update page.'))
      }
    }

    try {
      const page = await Page.findPageByPath(newPagePath)
      if (page.isUnlinkable(req.user)) {
        try {
          await page.unlink(req.user)
          rename()
        } catch (err) {
          res.json(ApiResponse.error(err))
        }
      } else {
        // can't rename to that path when page found and can't remove it
        return res.json(ApiResponse.error(`このページ名は作成できません (${newPagePath})。ページが存在します。`))
      }
    } catch (err) {
      rename()
    }
  }

  api.renameTree = async function(req: Request, res: Response) {
    const { path, new_path: newPath, create_redirect: createRedirect = 0 } = req.body
    const options = { createRedirectPage: createRedirect }

    const paths = await Page.findChildrenByPath(path, req.user, {})
    const pathMap = Page.getPathMap(paths, path, newPath)

    const [error, errors] = await Page.checkPagesRenamable(Object.values(pathMap), req.user)

    if (error) {
      const info = { errors, path_map: pathMap }
      return res.json(ApiResponse.error('rename_tree.error.can_not_move', info))
    }

    try {
      const result = await Page.renameTree(pathMap, req.user, options)
      return res.json(ApiResponse.success({ pages: result }))
    } catch (err) {
      return res.json(ApiResponse.error(err))
    }
  }

  api.checkTreeRenamable = async function(req: Request, res: Response) {
    const { path, new_path: newPath } = req.body

    const paths = await Page.findChildrenByPath(path, req.user, {})
    const pathMap = Page.getPathMap(paths, path, newPath)

    const [error, errors] = await Page.checkPagesRenamable(Object.values(pathMap), req.user)

    if (error) {
      const info = { errors, path_map: pathMap }
      return res.json(ApiResponse.error('rename_tree.error.can_not_move', info))
    }

    return res.json(ApiResponse.success({ path_map: pathMap }))
  }

  /**
   * @api {post} /pages.unlink Remove the redirecting page
   * @apiName UnlinkPage
   * @apiGroup Page
   *
   * @apiParam {String} page_id Page Id.
   * @apiParam {String} revision_id
   */
  api.unlink = async function(req: Request, res: Response) {
    const { page_id: pageId } = req.body
    try {
      const page = await Page.findPageByIdAndGrantedUser(pageId, req.user)
      debug('Unlink page', page._id, page.path)
      await Page.removeRedirectOriginPageByPath(page.path)
      debug('Redirect Page deleted', page.path)
      const result = { page }
      return res.json(ApiResponse.success(result))
    } catch (err) {
      debug('Error occured while get setting', err, err.stack)
      return res.json(ApiResponse.error('Failed to delete redirect page.'))
    }
  }

  api.watchStatus = async function(req: Request, res: Response) {
    const { page_id: pageId } = req.query
    const { _id: userId } = req.user as UserDocument
    try {
      const watcher = await Watcher.findByUserIdAndTargetId(userId, pageId)
      const getDefaultStatus = async () => {
        const page = await Page.findById(pageId)
        if (!page) throw new Error('Page not found')
        const targetUsers = await page.getNotificationTargetUsers()
        return targetUsers.some(user => user.toString() === userId.toString())
      }
      const watching = watcher ? watcher.isWatching() : await getDefaultStatus()
      const result = { watching }
      return res.json(ApiResponse.success(result))
    } catch (err) {
      debug('Error occured while get setting', err, err.stack)
      return res.json(ApiResponse.error('Failed to fetch watch status.'))
    }
  }

  api.watch = async function(req: Request, res: Response) {
    const { page_id: pageId } = req.body
    const { _id: userId } = req.user as UserDocument
    const status = req.body.status ? Watcher.STATUS_WATCH : Watcher.STATUS_IGNORE
    try {
      const watcher = await Watcher.watchByPageId(userId, pageId, status)
      const result = { watcher }
      return res.json(ApiResponse.success(result))
    } catch (err) {
      debug('Error occured while update watch status', err, err.stack)
      return res.json(ApiResponse.error('Failed to watch this page.'))
    }
  }

  return actions
}
