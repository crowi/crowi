import React from 'react'
import PropTypes from 'prop-types'

function ConnectButton({ hasSlackToken, slackAuthUrl }) {
  return hasSlackToken ? (
    <div className="text-center">
      <p>
        Crowi and Slack is already <strong>connected</strong>.You can re-connect to refresh and overwirte the token with your Slack account.
      </p>
      <a className="btn btn-secondary" href={slackAuthUrl}>
        <i className="mdi mdi-slack" /> Reconnect to Slack
      </a>
    </div>
  ) : (
    <div className="text-center">
      <p>Slack clientId and clientSecret is configured. Now, you can connect with Slack.</p>
      <a className="btn btn-primary" href={slackAuthUrl}>
        <i className="mdi mdi-slack" /> Connect to Slack
      </a>
    </div>
  )
}

ConnectButton.propTypes = {
  hasSlackToken: PropTypes.bool.isRequired,
  slackAuthUrl: PropTypes.string.isRequired,
}

export default ConnectButton
