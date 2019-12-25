import React, { FC } from 'react'
import { PageProps } from 'server/types/pageProps'
import Icon from 'client/components/Common/Icon'
import ProviderWidget from './ProviderWidget'

type Props = {
  warningMessage?: string
} & PageProps

const GoogleWidget: FC<Props> = props => {
  const { i18n, context, warningMessage } = props

  return (
    <ProviderWidget
      i18n={i18n}
      context={context}
      warningMessage={warningMessage}
      isEnabled={context.auth.providers.google}
      action="/me/auth/google"
      legend={
        <>
          <Icon name="google" /> {i18n.t('Google Setting')}
        </>
      }
      isConnected={!!context.user.googleId}
      disconnectButton={
        <input
          type="submit"
          name="disconnectGoogle"
          className="btn btn-secondary"
          value={i18n.t('Disconnect') as any}
          disabled={context.auth.canDisconnectThirdPartyId}
        />
      }
      disconnectMessages={[i18n.t('page_me.form_help.google_disconnect1'), i18n.t('page_me.form_help.google_disconnect2')]}
      connectButton={<input type="submit" name="connectGoogle" className="btn btn-google" value={i18n.t('Google Connect') as any} />}
      helpMessage={i18n.t('page_me.form_help.google_connect1')}
    />
  )
}

export default GoogleWidget
