import React, { FC } from 'react'

interface Props {
  hasSlackToken: boolean | null | undefined
  slackAuthUrl: string | null | undefined
}

const ConnectButton: FC<Props> = ({ hasSlackToken, slackAuthUrl }) => {
  const url = slackAuthUrl || undefined
  return hasSlackToken ? (
    <div className="text-center">
      <p>
        Crowi and Slack is already <strong>connected</strong>.You can re-connect to refresh and overwirte the token with your Slack account.
      </p>
      <a className="btn btn-secondary" href={url}>
        <i className="mdi mdi-slack" /> Reconnect to Slack
      </a>
    </div>
  ) : (
    <div className="text-center">
      <p>Slack clientId and clientSecret is configured. Now, you can connect with Slack.</p>
      <a className="btn btn-primary" href={url}>
        <i className="mdi mdi-slack" /> Connect to Slack
      </a>
    </div>
  )
}

export default ConnectButton
