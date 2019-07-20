import React, { FC } from 'react'
import { useTranslation, Trans } from 'react-i18next'

interface Props {
  appUrl: string
}

const Instructions: FC<Props> = ({ appUrl }) => {
  const [t] = useTranslation()

  return (
    <>
      <h3>{t('admin.notification.instructions.basic.legend')}</h3>
      <p>{t('admin.notification.instructions.basic.description')}</p>
      <h4>{t('admin.notification.instructions.basic.steps.0.title')}</h4>
      <p>
        <Trans i18nKey="admin.notification.instructions.basic.steps.0.description">
          Create App from{' '}
          <strong>
            <a href="https://api.slack.com/applications/new">this link</a>
          </strong>
          , and fill the form out as below:
        </Trans>
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
              <a href="https://github.com/crowi/crowi/tree/master/resource/logo">Crowi Logo</a> (Free to download and use it)
            </p>
          </dd>
        </div>
        <div className="row">
          <dt className="col-4">Redirect URL</dt>
          <dd className="col-8">
            <code>{appUrl}/admin/notification/slackAuth</code> in <code>OAuth &amp; Permissions</code> tab.
          </dd>
        </div>
        <div className="row">
          <dt className="col-4">Short description</dt>
          <dd className="col-8">
            <code>Crowi&#39;s Slack Notification Integration</code>
          </dd>
        </div>
        <div className="row">
          <dt className="col-4">Long description</dt>
          <dd className="col-8">
            <code>Crowi&#39;s Slack Notification Integration</code>
          </dd>
        </div>
      </dl>
      <p>
        and <strong>Save</strong> it.
      </p>

      <h4>
        <Trans i18nKey="admin.notification.instructions.basic.steps.1.title">
          Get <code>clientId</code> and <code>clientSecret</code>
        </Trans>
      </h4>
      <h4>
        <Trans i18nKey="admin.notification.instructions.basic.steps.2.title">
          After <code>clientId</code> and <code>clientSecret</code> set, click &quot;Connect to Slack&quot; button to start OAuth process.
        </Trans>
      </h4>
      <p>{t('admin.notification.instructions.basic.steps.2.description')}</p>
      <h4>{t('admin.notification.instructions.basic.steps.3.title')}</h4>

      <h3>{t('admin.notification.instructions.unfurl.legend')}</h3>
      <h4>{t('admin.notification.instructions.unfurl.steps.0.title')}</h4>
      <p>
        <Trans i18nKey="admin.notification.instructions.unfurl.steps.0.description">
          Create App from{' '}
          <strong>
            <a href="https://api.slack.com/applications/new">this link</a>
          </strong>
          , and fill the form out as below:
        </Trans>
      </p>
      <dl>
        <div className="row">
          <dt className="col-4">Request URL</dt>
          <dd className="col-8">
            <code>{appUrl}</code>
          </dd>
        </div>
        <div className="row">
          <dt className="col-4">Workspace Events</dt>
          <dd className="col-8">
            <code>link_shared</code>
          </dd>
        </div>
        <div className="row">
          <dt className="col-4">Domains</dt>
          <dd className="col-8">Your crowi domains</dd>
        </div>
      </dl>
    </>
  )
}

export default Instructions
