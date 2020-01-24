/* Author: Sotaro KARASAWA <sotarok@crocos.co.jp>
 */

import 'scrollpos-styler'
import { alert, linkVariant } from 'components/Common/Icons'
import renderIcon from 'common/functions/renderIcon'

export default class Crowi {
  static createErrorView = (msg: string) => {
    $('#main').prepend($('<p class="alert-message error">' + msg + '</p>'))
  }

  static linkPath = (revisionPath?: string) => {
    var $revisionPath = revisionPath || '#revision-path'
    var $title = $($revisionPath)
    var pathData = $('#content-main').data('path')

    if (!pathData) {
      return
    }

    var realPath = pathData.trim()
    if (realPath.substr(-1, 1) == '/') {
      realPath = realPath.substr(0, realPath.length - 1)
    }

    var path = ''
    var pathHtml = ''
    var splittedPath = realPath.split(/\//)
    splittedPath.shift()
    splittedPath.forEach((sub: string) => {
      path += '/'
      pathHtml += ' <a href="' + Crowi.escape(path) + '">/</a> '
      if (sub) {
        path += sub
        pathHtml += '<a href="' + Crowi.escape(path) + '">' + Crowi.escape(sub) + '</a>'
      }
    })
    if (path.substr(-1, 1) != '/') {
      path += '/'
      pathHtml += ' <a href="' + Crowi.escape(path) + '" class="last-path">/</a>'
    }
    $title.html(pathHtml)
  }

  static correctHeaders = (contentId: string) => {
    // h1 ~ h6 の id 名を補正する
    var $content = $(contentId || '#revision-body-content')
    var i = 0
    $('h1,h2,h3,h4,h5,h6', $content).each(function() {
      var id = 'head' + i++
      $(this).attr('id', id)
      $(this).addClass('revision-head')
      $(this).append(`<span class="revision-head-link"><a href="#${id}">${renderIcon(linkVariant)}</a></span>`)
    })
  }

  static revisionToc = (contentId, tocId) => {
    var $content = $(contentId || '#revision-body-content')
    var $tocId = $(tocId || '#revision-toc')

    var $tocContent = $('<div id="revision-toc-content" class="revision-toc-content collapse"></div>')
    $tocId.append($tocContent)

    $('h1', $content).each(function() {
      var id = $(this).attr('id')
      var title = $(this).text()
      var selector = '#' + id + ' ~ h2:not(#' + id + ' ~ h1 ~ h2)'

      var $toc = $('<ul></ul>')
      var $tocLi = $('<li><a href="#' + id + '">' + title + '</a></li>')

      $tocContent.append($toc)
      $toc.append($tocLi)

      $(selector).each(function() {
        var id2 = $(this).attr('id')
        var title2 = $(this).text()
        var selector2 = '#' + id2 + ' ~ h3:not(#' + id2 + ' ~ h2 ~ h3)'

        var $toc2 = $('<ul></ul>')
        var $tocLi2 = $('<li><a href="#' + id2 + '">' + title2 + '</a></li>')

        $tocLi.append($toc2)
        $toc2.append($tocLi2)

        $(selector2).each(function() {
          var id3 = $(this).attr('id')
          var title3 = $(this).text()

          var $toc3 = $('<ul></ul>')
          var $tocLi3 = $('<li><a href="#' + id3 + '">' + title3 + '</a></li>')

          $tocLi2.append($toc3)
          $toc3.append($tocLi3)
        })
      })
    })
  }

  static escape = (s: string) =>
    s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/'/g, '&#39;')
      .replace(/"/g, '&quot;')

  static unescape = (s: string) =>
    s
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&#39;/g, "'")
      .replace(/&quot;/g, '"')

  // original: middleware.swigFilter
  static userPicture = user => {
    if (!user) {
      return '/images/userpicture.png'
    }

    if (user.image && user.image != '/images/userpicture.png') {
      return user.image
    }

    return '/images/userpicture.png'
  }

  static modifyScrollTop = () => {
    var offset = 10

    var hash = window.location.hash
    if (hash === '') {
      return
    }

    var pageHeader = document.querySelector('#page-header')
    if (!pageHeader) {
      return
    }
    var pageHeaderRect = pageHeader.getBoundingClientRect()

    var sectionHeader = document.querySelector(hash)
    if (sectionHeader === null) {
      return
    }

    var timeout = 0
    if (window.scrollY === 0) {
      timeout = 200
    }
    setTimeout(() => {
      if (!sectionHeader) return
      var sectionHeaderRect = sectionHeader.getBoundingClientRect()
      if (sectionHeaderRect.top >= pageHeaderRect.bottom) {
        return
      }

      window.scrollTo(0, window.scrollY - pageHeaderRect.height - offset)
    }, timeout)
  }

  static findHashFromUrl = url => {
    var match
    if ((match = url.match(/#(.+)$/))) {
      return '#' + match[1]
    }

    return ''
  }

  static unhighlightSelectedSection = hash => {
    if (!hash || hash == '' || !hash.match(/^#head.+/)) {
      // とりあえず head* だけ (検索結果ページで副作用出た
      return true
    }
    $(hash).removeClass('highlighted')
  }

  static highlightSelectedSection = hash => {
    if (!hash || hash == '' || !hash.match(/^#head.+/)) {
      // とりあえず head* だけ (検索結果ページで副作用出た
      return true
    }
    $(hash).addClass('highlighted')
  }
}

$(function() {
  const crowi = window.crowi
  const crowiRenderer = window.crowiRenderer

  var pageId = $('#content-main').data('page-id')
  var isSeen = $('#content-main').data('page-is-seen')
  var pagePath = $('#content-main').data('path')
  var isSharePage = !!$('#content-main').data('is-share-page')

  Crowi.linkPath()

  $('[data-toggle="popover"]').popover()
  $('[data-toggle="tooltip"]').tooltip()
  $('[data-tooltip-stay]').tooltip('show')

  $('#toggle-sidebar').click(function(e) {
    var $mainContainer = $('.main-container')
    if ($mainContainer.hasClass('aside-hidden')) {
      $('.main-container').removeClass('aside-hidden')
      $.cookie('aside-hidden', 0, { expires: 30, path: '/' })
    } else {
      $mainContainer.addClass('aside-hidden')
      $.cookie('aside-hidden', 1, { expires: 30, path: '/' })
    }
    return false
  })

  if ($.cookie('aside-hidden') == 1) {
    $('.main-container').addClass('aside-hidden')
  }

  $('.copy-link').on('click', function() {
    $(this).select()
  })

  $('#create-page').on('shown.bs.modal', function(e) {
    // quick hack: replace from server side rendering "date" to client side "date"
    var today = new Date()
    var month = ('0' + (today.getMonth() + 1)).slice(-2)
    var day = ('0' + today.getDate()).slice(-2)
    var dateString = today.getFullYear() + '/' + month + '/' + day
    $('#create-page-today .page-today-suffix').text('/' + dateString + '/')
    $('#create-page-today .page-today-input2').data('prefix', '/' + dateString + '/')

    $('#create-page-today .form-control.page-today-input2').focus()
  })

  $('#create-page-today').submit(function(e) {
    var prefix1 = $('input.page-today-input1', this).data('prefix')
    var input1 = $('input.page-today-input1', this).val()
    var prefix2 = $('input.page-today-input2', this).data('prefix')
    var input2 = $('input.page-today-input2', this).val()
    if (input1 === '') {
      prefix1 = 'メモ'
    }
    if (input2 === '') {
      prefix2 = prefix2.slice(0, -1)
    }
    top.location.href = prefix1 + input1 + prefix2 + input2
    return false
  })

  $('#create-page-under-tree').submit(function(e) {
    var name = String($('input', this).val())
    if (!name.match(/^\//)) {
      name = '/' + name
    }
    if (name.match(/.+\/$/)) {
      name = name.substr(0, name.length - 1)
    }
    top.location.href = name
    return false
  })

  // rename
  const rename = (data, newPageNameCheck) =>
    $.ajax({
      type: 'POST',
      url: '/_api/pages.rename',
      data,
      dataType: 'json',
    }).done(function(res) {
      if (!res.ok) {
        newPageNameCheck.html(`${renderIcon(alert)} ${res.error}`)
        newPageNameCheck.addClass('alert-danger')
      } else {
        var page = res.page

        newPageNameCheck.removeClass('alert-danger')
        // $('#newPageNameCheck').html('<img src="/images/loading_s.gif"> 移動しました。移動先にジャンプします。');
        // fix
        newPageNameCheck.html('<img src="/images/loading_s.gif"> Page moved! Redirecting to new page location.')

        setTimeout(function() {
          top.location.href = page.path + '?redirectFrom=' + pagePath
        }, 1000)
      }
    })
  $('#renamePage').on('shown.bs.modal', function(e) {
    $('#newPageName').focus()
  })
  $('#renamePageForm, #unportalize-form, #portalize-form').submit(function(e) {
    rename($(this).serialize(), $(this).find('.new-page-name-check'))
    e.preventDefault()
    return false
  })

  $('#revert-delete-page-form').submit(function(e) {
    $.ajax({
      type: 'POST',
      url: '/_api/pages.revertRemove',
      data: $('#revert-delete-page-form').serialize(),
      dataType: 'json',
    }).done(function(res) {
      if (!res.ok) {
        $('#delete-errors').html(`${renderIcon(alert)} ${res.error}`)
        $('#delete-errors').addClass('alert-danger')
      } else {
        var page = res.page
        top.location.href = page.path
      }
    })

    return false
  })
  $('#unlink-page-form').submit(function(e) {
    $.ajax({
      type: 'POST',
      url: '/_api/pages.unlink',
      data: $('#unlink-page-form').serialize(),
      dataType: 'json',
    }).done(function(res) {
      if (!res.ok) {
        $('#delete-errors').html(`${renderIcon(alert)} ${res.error}`)
        $('#delete-errors').addClass('alert-danger')
      } else {
        var page = res.page
        top.location.href = page.path + '?unlinked=true'
      }
    })

    return false
  })

  $('#create-portal-button').on('click', function(e) {
    $('.portal').removeClass('d-none')
    $('.content-main').addClass('on-edit')
    $('.portal a[data-toggle="tab"][href="#edit-form"]').tab('show')

    var path = $('.content-main').data('path')
    if (path != '/' && $('.content-main').data('page-id') == '') {
      var upperPage = path.substr(0, path.length - 1)
      $.get('/_api/pages.get', { path: upperPage }, function(res) {
        if (res.ok && res.page) {
          $('#portal-warning-modal').modal('show')
        }
      })
    }
  })
  $('#portal-form-close').on('click', function(e) {
    $('.portal').addClass('d-none')
    $('.content-main').removeClass('on-edit')

    return false
  })

  // list-link
  $('.page-list-link-path').each(function() {
    const $link = $(this)
    const path = $link.attr('data-path')
    const shortPath = $link.attr('data-short-path') || ''

    if (path !== undefined && shortPath !== undefined) {
      const pathPrefix = path.slice(0, -shortPath.length)
      $link.html(`${Crowi.escape(pathPrefix)}<strong>${Crowi.escape(shortPath)}</strong>`)
    }
  })

  // for list page
  $('a[data-toggle="tab"][href="#view-timeline"]').on('show.bs.tab', function() {
    var isShown = $('#view-timeline').data('shown')
    if (isShown == 0) {
      $('#view-timeline .timeline-body').each(function() {
        var id = $(this).attr('id')
        var contentId = '#' + id + ' > script'
        var revisionBody = '#' + id + ' .revision-body'
        var $revisionBody = $(revisionBody)
        // var revisionPath = '#' + id + ' .revision-path'

        var markdown = Crowi.unescape($(contentId).html())
        var parsedHTML = crowiRenderer.render(markdown, $revisionBody.get(0))
        $revisionBody.html(parsedHTML)

        $('.template-create-button', $revisionBody).on('click', function() {
          var path = $(this).data('path')
          var templateId = $(this).data('template')
          var template = $('#' + templateId).html()

          crowi.saveDraft(path, template)
          top.location.href = path
        })
      })

      $('#view-timeline').data('shown', 1)
    }
  })

  $('#register-form input[name="registerForm[username]"]').change(function(e) {
    var username = $(this).val()
    $('#input-group-username').removeClass('has-error')
    $('#help-block-username').html('')

    $.getJSON('/_api/check_username', { username: username }, function(json) {
      if (!json.valid) {
        $('#help-block-username').html(`${renderIcon(alert)} This User ID is not available.<br>`)
        $('#input-group-username').addClass('has-error')
      }
    })
  })

  // omg /login/invited
  $('#invited-form input[name="invitedForm[username]"]').change(function(e) {
    var username = $(this).val()
    $('#input-group-username').removeClass('has-error')
    $('#help-block-username').html('')

    $.getJSON('/_api/check_username', { username: username }, function(json) {
      if (!json.valid) {
        $('#help-block-username').html(`${renderIcon(alert)} This User ID is not available.<br>`)
        $('#input-group-username').addClass('has-error')
      }
    })
  })

  // moved from view /me/index.html
  $('#pictureUploadForm input[name=userPicture]').on('change', async function() {
    // clear message before process change
    $('#pictureUploadFormMessage')
      .removeClass()
      .empty()

    const $form = $('#pictureUploadForm')
    const formElement = $form[0] as HTMLFormElement
    const formInputElement = formElement.elements[0] as HTMLInputElement
    // check cancel/abort
    if (formInputElement.files && formInputElement.files.length === 0) return
    const fd = new FormData(formElement)

    // Like first aid, we'll drop this function with react+cropper.js after.
    const picture = fd.get('userPicture') as File
    const { name: pictureName, type: pictureType } = picture
    let pictureSource: ImageBitmap | HTMLImageElement | null = null
    try {
      pictureSource = await ((): Promise<ImageBitmap | HTMLImageElement> => {
        if ('createImageBitmap' in window) return createImageBitmap(picture)
        return new Promise((resolve, reject) => {
          const element = document.createElement('img')
          const objectURL = URL.createObjectURL(picture)
          element.addEventListener('load', () => {
            URL.revokeObjectURL(objectURL)
            resolve(element)
          })
          element.addEventListener('error', reject)
          element.src = objectURL
        })
      })()
    } catch (e) {
      $('#pictureUploadFormMessage')
        .removeClass()
        .addClass('alert alert-danger')
        .html(e.message)
      return
    }

    /**
     * @param {string} image
     * @param {number} size square size in px
     * @param {string} type output mime-type
     * @param {number} [quality=0.95] output quality
     * @returns {Promise<Blob>}
     */
    const convert = (image, size, type, quality = 0.95): Promise<Blob | null> => {
      const [w, h] = [image.naturalWidth || image.width, image.naturalHeight || image.height]
      const s = w > h ? h : w

      /**
       * 正方形に整形、中央寄せ
       * 現在 img に対して `vertical-align: middle` が指定されているので、この変換器を入れても何も問題がない
       */
      const canvas = (() => {
        if ('OffscreenCanvas' in window) return new OffscreenCanvas(s, s)
        const element = document.createElement('canvas')
        element.width = element.height = s
        return element
      })()
      const ctx = canvas.getContext('2d') as CanvasRenderingContext2D
      ctx.drawImage(image, (w - s) / 2, (h - s) / 2, s, s, 0, 0, s, s)

      /**
       * 1/2 単位で、だいたいのサイズにする
       * フィルターの性能不足があり、直接変換するとジャギーなどが発生することがある (らしい)
       * https://stackoverflow.com/questions/17861447/html5-canvas-drawimage-how-to-apply-antialiasing
       */
      while (canvas.height / 2 > size) {
        const ctx = canvas.getContext('2d') as CanvasRenderingContext2D

        // Save current canvas state to pettern
        const pattern = ctx.createPattern(canvas, 'no-repeat') as CanvasPattern
        const { width, height } = canvas

        // Resize to 1/4 (and canvas state will clear)
        canvas.width /= 2
        canvas.height /= 2

        ctx.scale(0.5, 0.5)
        ctx.fillStyle = pattern
        ctx.fillRect(0, 0, width, height)
      }

      // Offscrean canvas
      if (!(canvas instanceof HTMLElement)) {
        return canvas.convertToBlob({ type, quality })
      }
      // HTML Element
      return new Promise(resolve => {
        canvas.toBlob(resolve, type, quality)
      })
    }

    try {
      const acceptTypes = ['image/jpeg', 'image/png']
      // If convertable image without format that can't be output, choose jpeg
      const targetType = (acceptTypes.includes(pictureType) && pictureType) || 'image/jpeg'
      const suffix = acceptTypes.includes(pictureType) ? '' : '.compact.jpg'
      const blob = await convert(pictureSource, 128, targetType)
      if (blob) {
        fd.set('userPicture', blob, pictureName + suffix)
      }
    } catch (e) {
      $('#pictureUploadFormMessage')
        .removeClass()
        .addClass('alert alert-danger')
        .html(e.message)
      return
    }

    if ($(this).val() == '') {
      return false
    }

    $('#pictureUploadFormProgress').html('<img src="/images/loading_s.gif"> Uploading ...')
    $.ajax($form.attr('action') as string, {
      type: 'post',
      processData: false,
      contentType: false,
      data: fd,
      dataType: 'json',
      success: function(data) {
        if (data.status) {
          $('#settingUserPicture').attr('src', data.url + '?time=' + new Date())
          $('#pictureUploadFormMessage')
            .removeClass()
            .addClass('alert alert-success')
            .html('Updated.')
        } else {
          $('#pictureUploadFormMessage')
            .removeClass()
            .addClass('alert alert-danger')
            .html('Failed to update profile picture.')
        }
        $('#pictureUploadFormProgress').html('')
      },
    })
    return false
  })

  if (pageId) {
    // if page exists
    var $rawTextOriginal = $('#raw-text-original')
    if ($rawTextOriginal.length > 0) {
      var markdown = Crowi.unescape($('#raw-text-original').html())
      var revisionBody = $('#revision-body-content')
      var parsedHTML = crowiRenderer.render(markdown, revisionBody.get(0))
      revisionBody.html(parsedHTML)

      $('.template-create-button').on('click', function() {
        var path = $(this).data('path')
        var templateId = $(this).data('template')
        var template = $('#' + templateId).html()

        crowi.saveDraft(path, template)
        top.location.href = path
      })

      Crowi.correctHeaders('#revision-body-content')
      Crowi.revisionToc('#revision-body-content', '#revision-toc')
    }

    // header
    const $headerWrap = $('.header-wrap')
    const $dummyHeaderWrap = $('.dummy-header-wrap')
    if ($headerWrap.length > 0 && $dummyHeaderWrap.length > 0) {
      const initialHeaderWrapOffset = $headerWrap.position().top
      $headerWrap.attr('data-sps-offset', initialHeaderWrapOffset)

      const initialHeaderWrapHeight = $headerWrap.outerHeight() || 0
      $dummyHeaderWrap.css('height', initialHeaderWrapHeight)

      $(window).resize(() => {
        const headerWrapOffset = $headerWrap.position().top || $dummyHeaderWrap.position().top
        $headerWrap.attr('data-sps-offset', headerWrapOffset)

        const headerWrapHeight = $headerWrap.outerHeight() || 0
        $dummyHeaderWrap.css('height', headerWrapHeight)
      })

      $('.stopper').on('click', e => {
        $headerWrap.removeClass('sps sps--abv sps--blw')
        return false
      })
    }

    const AddToLikers = function(users) {
      $.each(users, function(i, user) {
        $likerList.append(CreateUserLinkWithPicture(user))
      })
    }

    const CreateUserLinkWithPicture = function(user) {
      var $userHtml = $('<a>')
      $userHtml.data('user-id', user._id)
      $userHtml.attr('href', '/user/' + user.username)
      $userHtml.attr('title', user.name)

      var $userPicture = $('<img class="picture picture-xs picture-rounded">')
      $userPicture.attr('alt', user.name)
      $userPicture.attr('src', Crowi.userPicture(user))

      $userHtml.append($userPicture)
      return $userHtml
    }

    const MarkLiked = function() {
      $likeButton.addClass('active')
      $likeButton.data('liked', 1)
      $likeCount.text(parseInt($likeCount.text()) + 1)
    }

    const MarkUnLiked = function() {
      $likeButton.removeClass('active')
      $likeButton.data('liked', 0)
      $likeCount.text(parseInt($likeCount.text()) - 1)
    }

    // Like
    var $likeButton = $('.like-button')
    var $likeCount = $('#like-count')
    $likeButton.click(function() {
      var liked = $likeButton.data('liked')
      var token = $likeButton.data('csrftoken')
      if (!liked) {
        $.post('/_api/likes.add', { _csrf: token, page_id: pageId }, function(res) {
          if (res.ok) {
            MarkLiked()
          }
        })
      } else {
        $.post('/_api/likes.remove', { _csrf: token, page_id: pageId }, function(res) {
          if (res.ok) {
            MarkUnLiked()
          }
        })
      }

      return false
    })
    var $likerList = $('#liker-list')
    var likers = $likerList.data('likers')
    if (likers && likers.length > 0) {
      var users = crowi.findUserByIds(likers.split(','))
      if (users) {
        AddToLikers(users)
      }
    }

    if (!isSeen && !isSharePage) {
      $.post('/_api/pages.seen', { page_id: pageId }, function(res) {
        // ignore unless response has error
        if (res.ok && res.seenUser) {
          $('#content-main').data('page-is-seen', 1)
        }
      })
    }

    // presentation
    var presentaionInitialized = false
    var $b = $('body')

    $(document)
      .on('click', '.toggle-presentation', function(e) {
        var $a = $(this)

        e.preventDefault()
        $b.toggleClass('overlay-on')

        if (!presentaionInitialized) {
          presentaionInitialized = true

          $('<iframe />')
            .attr({
              src: $a.attr('href'),
            })
            .appendTo($('#presentation-container'))
        }
      })
      .on('click', '.fullscreen-layer', function() {
        $b.toggleClass('overlay-on')
      })
  } // end if pageId

  // hash handling
  $('a[data-toggle="tab"][href="#revision-history"]').on('show.bs.tab', function() {
    window.history.pushState('', 'History', '#revision-history')
  })
  $('a[data-toggle="tab"][href="#edit-form"]').on('show.bs.tab', function() {
    window.history.pushState('', 'Edit', '#edit-form')
  })
  $('a[data-toggle="tab"][href="#revision-body"]').on('show.bs.tab', function() {
    window.history.pushState('', '', location.href.replace(location.hash, ''))
  })

  $(document).on('click', '#external-share .dropdown-menu', function(e) {
    e.stopPropagation()
  })
})

window.addEventListener('load', function(e) {
  const crowi = window.crowi

  // hash on page
  if (location.hash) {
    if (location.hash == '#edit-form') {
      $('a[data-toggle="tab"][href="#edit-form"]').tab('show')
    }
    if (location.hash == '#revision-history') {
      $('a[data-toggle="tab"][href="#revision-history"]').tab('show')
    }
  }

  if ((crowi && crowi.users) || crowi.users.length == 0) {
    var totalUsers = crowi.users.length
    var $listLiker = $('.page-list-liker')
    $listLiker.each(function(i, liker) {
      var count = $(liker).data('count') || 0
      if (count / totalUsers > 0.05) {
        $(liker).addClass('popular-page-high')
        // 5%
      } else if (count / totalUsers > 0.02) {
        $(liker).addClass('popular-page-mid')
        // 2%
      } else if (count / totalUsers > 0.005) {
        $(liker).addClass('popular-page-low')
        // 0.5%
      }
    })
    var $listSeer = $('.page-list-seer')
    $listSeer.each(function(i, seer) {
      var count = $(seer).data('count') || 0
      if (count / totalUsers > 0.1) {
        // 10%
        $(seer).addClass('popular-page-high')
      } else if (count / totalUsers > 0.05) {
        // 5%
        $(seer).addClass('popular-page-mid')
      } else if (count / totalUsers > 0.02) {
        // 2%
        $(seer).addClass('popular-page-low')
      }
    })
  }

  Crowi.highlightSelectedSection(location.hash)
  Crowi.modifyScrollTop()
})

window.addEventListener('hashchange', function(e) {
  Crowi.unhighlightSelectedSection(Crowi.findHashFromUrl(e.oldURL))
  Crowi.highlightSelectedSection(Crowi.findHashFromUrl(e.newURL))
  Crowi.modifyScrollTop()

  // hash on page
  if (location.hash) {
    if (location.hash == '#edit-form') {
      $('a[data-toggle="tab"][href="#edit-form"]').tab('show')
    }
    if (location.hash == '#revision-history') {
      $('a[data-toggle="tab"][href="#revision-history"]').tab('show')
    }
  }
  if (location.hash == '' || location.hash.match(/^#head.+/)) {
    $('a[data-toggle="tab"][href="#revision-body"]').tab('show')
  }
})
