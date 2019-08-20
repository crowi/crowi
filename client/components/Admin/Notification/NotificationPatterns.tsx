import React, { useState, FC } from 'react'
import { useTranslation, Trans } from 'react-i18next'
import { Input, Button, FormText } from 'reactstrap'

interface Props {
  settings: any[]
  addPattern: ({ pathPattern, channel }: { pathPattern: string; channel: string }) => void
  removePattern: (pattern: string) => void
}

const NotificationPatterns: FC<Props> = ({ settings, addPattern, removePattern }) => {
  const [t] = useTranslation()
  const [pathPattern, setPathPattern] = useState('')
  const [channel, setChannel] = useState('')

  const clearInputs = () => {
    setPathPattern('')
    setChannel('')
  }

  const handleAddPattern = () => {
    addPattern({ pathPattern, channel })
    clearInputs()
  }

  return (
    <>
      <h3 className="mt-4">{t('admin.notification.patterns.legend')}</h3>

      <div className="row">
        <table className="offset-1 col-10 table table-bordered">
          <thead>
            <tr>
              <th>{t('admin.notification.patterns.pattern')}</th>
              <th>{t('admin.notification.patterns.channel')}</th>
              <th>{t('admin.notification.patterns.operation')}</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>
                <Input value={pathPattern} placeholder="e.g. /projects/xxx/MTG/*" onChange={e => setPathPattern(e.target.value)} />
                <FormText color="muted">
                  <Trans i18nKey="admin.notification.patterns.path_pattern_description">
                    Path name of wiki. Pattern expression with <code>*</code> can be used.
                  </Trans>
                </FormText>
              </td>
              <td>
                <Input value={channel} placeholder="e.g. project-xxx" onChange={e => setChannel(e.target.value)} />
                <FormText color="muted">
                  <Trans i18nKey="admin.notification.patterns.channel_description">
                    Slack channel name. Without <code>#</code>.
                  </Trans>
                </FormText>
              </td>
              <td>
                <Button color="primary" onClick={handleAddPattern}>
                  {t('Add')}
                </Button>
              </td>
            </tr>

            {settings.map(({ _id, pathPattern, channel }) => (
              <tr key={_id}>
                <td>{pathPattern}</td>
                <td>{channel}</td>
                <td>
                  <form className="admin-remove-updatepost">
                    <Button onClick={() => removePattern(_id)}>{t('Delete')}</Button>
                  </form>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  )
}

export default NotificationPatterns
