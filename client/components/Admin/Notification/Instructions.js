import React from 'react'

class Instructions extends React.Component {
  render() {
    return (
      <>
        <h3>How to configure Slack app for Crowi</h3>
        <p>Register Crowi as a Slack application, the notification feature for Slack can be enabled.</p>
        <h4>1. Register Slack App</h4>
        <p>
          Create App from <a href="https://api.slack.com/applications/new">this link</a>, and fill the form out as below:
        </p>
        <dl>
          <div className="row">
            <dt className="col-4">App Name</dt>
            <dd className="col-8">
              <code>Crowi</code>
            </dd>
          </div>
          <div className="row">
            <dt className="col-4">Icon</dt>
            <dd className="col-8">
              <p>Upload this image as the icon</p>
              <p>
                (Free to download and use it) =&gt; <a href="https://github.com/crowi/crowi/tree/master/resource/logo">Crowi Logo</a>
              </p>
            </dd>
          </div>
          <div className="row">
            <dt className="col-4">Short description</dt>
            <dd className="col-8">
              <code>Crowi's Slack Notification Integration</code>
            </dd>
          </div>
          <div className="row">
            <dt className="col-4">Long description</dt>
            <dd className="col-8">
              <code>Crowi's Slack Notification Integration</code>
            </dd>
          </div>
        </dl>
        <p>
          and <strong>Save</strong> it.
        </p>

        <h4>
          2. Get <code>clientId</code> and <code>clientSecret</code>
        </h4>
        <h4>3. Start OAuth process.</h4>
        <p>Click "Connect to Slack" button to start OAuth process.</p>
        <h4>4. Configure Slack on this notification setting screen</h4>
      </>
    )
  }
}

export default Instructions
