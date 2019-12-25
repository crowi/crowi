import React, { FC } from 'react'
import { PageProps } from 'server/types/pageProps'
import Alert from 'server/components/Alert'

type Props = {
  warningMessage?: string
  isEnabled: boolean
  action: string
  legend: React.ReactNode
  isConnected: boolean
  disconnectButton: React.ReactNode
  disconnectMessages: [string, string]
  connectButton: React.ReactNode
  helpMessage: string
} & PageProps

const ProviderWidget: FC<Props> = props => {
  const { i18n, context } = props
  const { warningMessage, isEnabled, action, legend, isConnected, disconnectButton, disconnectMessages, connectButton, helpMessage } = props

  return isEnabled ? (
    <div className="col-sm-6">
      <div className="form-box">
        <form action={action} method="post" className="form-horizontal" role="form">
          <fieldset>
            <legend>{legend}</legend>

            <Alert type="danger" messages={warningMessage} />

            <div className="form-group row">
              {isConnected ? (
                <div className="col-sm-12">
                  <p>
                    {i18n.t('Connected')}
                    {disconnectButton}
                  </p>
                  <p className="form-text text-muted">
                    {disconnectMessages[0]}
                    <br />
                    {disconnectMessages[1]}
                  </p>
                  {context.auth.canDisconnectThirdPartyId && <p className="form-text text-muted">{i18n.t('page_me.can_not_disconnect')}</p>}
                </div>
              ) : (
                <div className="col-sm-12">
                  <div className="text-center">{connectButton}</div>
                  <p className="form-text text-muted">
                    {helpMessage}
                    <br />
                  </p>
                  {context.security.registrationWhiteList.length ? (
                    <>
                      <p className="form-text text-muted">{i18n.t('page_register.form_help.email')}</p>
                      <ul>
                        {context.security.registrationWhiteList.map(em => (
                          <li key={em}>
                            <code>{em}</code>
                          </li>
                        ))}
                      </ul>
                    </>
                  ) : null}
                </div>
              )}
            </div>
          </fieldset>
        </form>
      </div>
    </div>
  ) : null
}

export default ProviderWidget
