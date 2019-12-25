import React, { FC } from 'react'
import classNames from 'classnames'
import { PageProps } from 'server/types/pageProps'
import Base, { Props as BaseProps } from 'server/pages/Me/Base'
import { getUserPicture } from 'client/services/user'
import GoogleWidget from './GoogleWidget'
import GitHubWidget from './GitHubWidget'

type Props = {
  activeItem: BaseProps['activeItem']
  messages: BaseProps['messages'] & { google?: { warning?: string }; github?: { warning?: string } }
} & PageProps

const IndexPage: FC<Props> = props => {
  const { i18n, context, messages } = props
  const { user } = context

  return (
    <Base title={i18n.t('User Settings')} {...props}>
      <div className="form-box">
        <form action="/me" method="post" className="form-horizontal" role="form">
          <fieldset>
            <legend>{i18n.t('Basic Info')}</legend>
            <div className="form-group row">
              <label htmlFor="name" className="offset-1 col-sm-2 control-label">
                {i18n.t('Name')}
              </label>
              <div className="col-sm-4">
                <input id="name" className="form-control" type="text" name="userForm[name]" value={user.name} required />
              </div>
            </div>
            <div className={classNames('form-group', 'row', user.email && 'has-error')}>
              <label htmlFor="email" className="offset-1 col-sm-2 control-label">
                {i18n.t('Email')}
              </label>
              <div className="col-sm-4">
                <input id="email" className="form-control" type="email" name="userForm[email]" value={user.email || ''} required />
              </div>
              <div className="offset-2 col-sm-10">
                {context.security.registrationWhiteList.length ? (
                  <>
                    <p className="form-text text-muted">
                      {i18n.t('page_register.form_help.email')}
                      <ul>
                        {context.security.registrationWhiteList.map(em => (
                          <li key={em}>
                            <code>{{ em }}</code>
                          </li>
                        ))}
                      </ul>
                    </p>
                  </>
                ) : null}
              </div>
            </div>
            <div className={classNames('form-group', 'row', user.language && 'has-error')}>
              <label className="offset-1 col-sm-2 control-label">{i18n.t('Language')}</label>
              <div className="col-sm-4">
                <div className="custom-control custom-radio custom-control-inline">
                  {/* FIXME: Use constants */}
                  <input
                    type="radio"
                    id="lang-en"
                    name="userForm[lang]"
                    className="custom-control-input"
                    value="en-US"
                    checked={context.user.language === 'en-US'}
                  />
                  <label className="custom-control-label" htmlFor="lang-en">
                    {i18n.t('English')}
                  </label>
                </div>
                <div className="custom-control custom-radio custom-control-inline">
                  {/* FIXME: Use constants */}
                  <input type="radio" id="lang-ja" name="userForm[lang]" className="custom-control-input" value="ja" checked={context.user.language === 'ja'} />
                  <label className="custom-control-label" htmlFor="lang-ja">
                    {i18n.t('Japanese')}
                  </label>
                </div>
              </div>
            </div>
            <div className="form-group row">
              <div className="offset-3 col-sm-10">
                <button type="submit" className="btn btn-primary">
                  {i18n.t('Update')}
                </button>
              </div>
            </div>
          </fieldset>
        </form>
      </div>

      <div className="form-box">
        <fieldset>
          <legend>{i18n.t('Set Profile Image')}</legend>
          <div id="pictureUploadFormMessage"></div>
          <div className="form-group row">
            <label htmlFor="" className="offset-1 col-sm-2 control-label">
              {i18n.t('Current Image')}
            </label>
            <div className="col-sm-8">
              <p>
                <img src={getUserPicture(user)} width="64" id="settingUserPicture" />
                <br />
              </p>
              <p>
                <script
                  dangerouslySetInnerHTML={{
                    __html: `document.addEventListener('submit', e => {
                      if (e.target.getAttribute('id') === 'delete-picture') {
                        window.confirm('${i18n.t('Delete this image?')}')
                      }
                    })`,
                  }}
                ></script>
                {user.image && (
                  <form id="delete-picture" action="/me/picture/delete" method="post" className="form-horizontal" role="form">
                    <button type="submit" className="btn btn-danger">
                      {i18n.t('Delete Image')}
                    </button>
                  </form>
                )}
              </p>
            </div>
          </div>

          <div className="form-group row">
            <label className="offset-1 col-sm-2 control-label">{i18n.t('Upload new image')}</label>
            <div className="col-sm-7">
              {context.upload.image ? (
                <form
                  action="/_api/me/picture/upload"
                  id="pictureUploadForm"
                  method="post"
                  className="form-horizontal"
                  role="form"
                  encType="multipart/form-data"
                >
                  <input name="userPicture" type="file" accept="image/*" />
                  <div id="pictureUploadFormProgress"></div>
                </form>
              ) : (
                <>
                  * {i18n.t('page_me.form_help.profile_image1')}
                  <br />* {i18n.t('page_me.form_help.profile_image2')}
                  <br />
                </>
              )}
            </div>
          </div>
        </fieldset>
      </div>

      <div className="row">
        <GoogleWidget i18n={i18n} context={context} warningMessage={messages.google?.warning} />
        <GitHubWidget i18n={i18n} context={context} warningMessage={messages.github?.warning} />
      </div>
    </Base>
  )
}

export default IndexPage
