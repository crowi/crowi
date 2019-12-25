import React, { FC } from 'react'
import classNames from 'classnames'
import { PageProps } from 'server/types/pageProps'
import Base, { Props as BaseProps } from 'server/pages/Me/Base'

type Props = {
  apiToken: string
  hasPassword: boolean
  activeItem: BaseProps['activeItem']
  messages: BaseProps['messages']
} & PageProps

const ApiTokenPage: FC<Props> = props => {
  const { i18n, apiToken, hasPassword } = props

  return (
    <Base title={i18n.t('API Settings')} {...props}>
      <div id="form-box">
        <form action="/me/apiToken" method="post" className="form-horizontal" role="form">
          <fieldset>
            <legend>{i18n.t('API Token Settings')}</legend>
            <div className={classNames('form-group', 'row', hasPassword && 'has-error')}>
              <label htmlFor="api-token" className="col-3 control-label">
                {i18n.t('Current API Token')}
              </label>
              <div className="col-6">
                {apiToken ? (
                  <input name="api-token" className="form-control" type="text" value={apiToken} readOnly />
                ) : (
                  <p className="form-control-static">{i18n.t('page_me_apitoken.notice.apitoken_issued')}</p>
                )}
              </div>
            </div>

            <div className="form-group">
              <div className="offset-3 col-8">
                <p className="alert alert-warning">
                  {i18n.t('page_me_apitoken.notice.update_token1')}
                  <br />
                  {i18n.t('page_me_apitoken.notice.update_token2')}
                </p>

                <button type="submit" value="1" name="apiTokenForm[confirm]" className="btn btn-primary">
                  {i18n.t('Update API Token')}
                </button>
              </div>
            </div>
          </fieldset>
        </form>
      </div>
    </Base>
  )
}

export default ApiTokenPage
