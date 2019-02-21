import React from 'react'
import { useTranslation, Trans } from 'react-i18next'

export default function Instructions() {
  const [t] = useTranslation()

  return (
    <>
      <h3>{t('admin.notification.instructions.legend')}</h3>
      <p>{t('admin.notification.instructions.description')}</p>
      <h4>{t('admin.notification.instructions.step1')}</h4>
      <p>
        <Trans i18nKey="admin.notification.instructions.step1_description">
          Create App from <a href="https://api.slack.com/applications/new">this link</a>, and fill the form out as below:
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
              (Free to download and use it) =&gt; <a href="https://github.com/crowi/crowi/tree/master/resource/logo">Crowi Logo</a>
            </p>
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
        <Trans i18nKey="admin.notification.instructions.step2">
          Get <code>clientId</code> and <code>clientSecret</code>
        </Trans>
      </h4>
      <h4>{t('admin.notification.instructions.step3')}</h4>
      <p>{t('admin.notification.instructions.step3_description')}</p>
      <h4>{t('admin.notification.instructions.step4')}</h4>
    </>
  )
}
