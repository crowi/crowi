import React, { FC } from 'react'
import { PageProps } from 'server/types/pageProps'
import Icon from 'client/components/Common/Icon'
import ProviderWidget from './ProviderWidget'

type Props = {
  warningMessage?: string
} & PageProps

const GitHubWidget: FC<Props> = props => {
  const { i18n, context, warningMessage } = props

  return (
    <ProviderWidget
      i18n={i18n}
      context={context}
      warningMessage={warningMessage}
      isEnabled={context.auth.providers.github}
      action="/me/auth/github"
      legend={
        <>
          <Icon name="githubBox" /> {i18n.t('GitHub Setting')}
        </>
      }
      isConnected={!!context.user.githubId}
      disconnectButton={
        <input
          type="submit"
          name="disconnectGitHub"
          className="btn btn-secondary"
          value={i18n.t('Disconnect') as any}
          disabled={context.auth.canDisconnectThirdPartyId}
        />
      }
      disconnectMessages={[i18n.t('page_me.form_help.github_disconnect1'), i18n.t('page_me.form_help.github_disconnect2')]}
      connectButton={<input type="submit" name="connectGitHub" className="btn btn-github" value={i18n.t('GitHub Connect') as any} />}
      helpMessage={i18n.t('page_me.form_help.github_connect1')}
    />
  )
}

export default GitHubWidget
