import React, { useState } from 'react'
import PropTypes from 'prop-types'
import { Input, Button, FormText } from 'reactstrap'

function NotificationPatterns({ settings, addPattern, removePattern }) {
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
      <h3 className="mt-4">Default Notification Settings for Patterns</h3>

      <div className="row">
        <table className="offset-1 col-10 table table-bordered">
          <thead>
            <tr>
              <th>Pattern</th>
              <th>Channel</th>
              <th>Operation</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>
                <Input value={pathPattern} placeholder="e.g. /projects/xxx/MTG/*" onChange={e => setPathPattern(e.target.value)} />
                <FormText color="muted">
                  Path name of wiki. Pattern expression with <code>*</code> can be used.
                </FormText>
              </td>
              <td>
                <Input value={channel} placeholder="e.g. project-xxx" onChange={e => setChannel(e.target.value)} />
                <FormText color="muted">
                  Slack channel name. Without <code>#</code>.
                </FormText>
              </td>
              <td>
                <Button color="primary" onClick={handleAddPattern}>
                  Add
                </Button>
              </td>
            </tr>

            {settings.map(({ _id, pathPattern, channel }) => (
              <tr key={_id}>
                <td>{pathPattern}</td>
                <td>{channel}</td>
                <td>
                  <form className="admin-remove-updatepost">
                    <Button onClick={() => removePattern(_id)}>Delete</Button>
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

NotificationPatterns.propTypes = {
  settings: PropTypes.array.isRequired,
}

export default NotificationPatterns
