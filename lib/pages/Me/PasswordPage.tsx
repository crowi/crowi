import React, { FC } from 'react'
import { Trans } from 'react-i18next'
import { PageProps } from 'server/types/pageProps'
import Base, { Props as BaseProps } from 'server/pages/Me/Base'

type Props = {
  hasPassword: boolean
  activeItem: BaseProps['activeItem']
  messages: BaseProps['messages']
} & PageProps

const PasswordPage: FC<Props> = props => {
  const { i18n, context, hasPassword } = props
  const { user } = context

  return (
    <Base title={i18n.t('Password Settings')} {...props}>
      {hasPassword && <div className="alert alert-danger">{i18n.t('Please set a password')}</div>}

      {user.email && (
        <p>
          <Trans i18nKey="You can sign in with email and password">
            You can sign in with <code>{{ email: user.email }}</code> and password
          </Trans>
        </p>
      )}

      <div id="form-box">
        <form action="/me/password" method="post" className="form-horizontal" role="form">
          <fieldset>
            {hasPassword ? <legend>{i18n.t('Update Password')}</legend> : <legend>{i18n.t('Set new Password')}</legend>}
            {hasPassword && (
              <div className="form-group row">
                <label htmlFor="oldPassword" className="offset-1 col-3 control-label">
                  {i18n.t('Current password')}
                </label>
                <div className="col-7">
                  <input id="oldPassword" className="form-control" type="password" name="mePassword[oldPassword]" />
                </div>
              </div>
            )}

            <div className="form-group row {% if not user.password %}has-error{% endif %}">
              <label htmlFor="newPassword" className="offset-1 col-3 control-label">
                {i18n.t('New password')}
              </label>
              <div className="col-7">
                <input id="newPassword" className="form-control" type="password" name="mePassword[newPassword]" required />
              </div>
            </div>

            <div className="form-group row">
              <label htmlFor="newPasswordConfirm" className="offset-1 col-3 control-label">
                {i18n.t('Re-enter new password')}
              </label>
              <div className="col-7">
                <input id="newPasswordConfirm" className="form-control" type="password" name="mePassword[newPasswordConfirm]" required />
                <p className="help-text text-muted">{i18n.t('page_register.form_help.password')}</p>
              </div>
            </div>

            <div className="form-group row">
              <div className="offset-4 col-7">
                <button type="submit" className="btn btn-primary">
                  {i18n.t('Update')}
                </button>
              </div>
            </div>
          </fieldset>
        </form>
      </div>
    </Base>
  )
}

export default PasswordPage
