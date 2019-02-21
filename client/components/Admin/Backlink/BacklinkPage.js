import React, { useContext, useState } from 'react'
import { Alert, Button, FormGroup, Label, FormText, Row, Col } from 'reactstrap'

import { AdminContext } from 'components/Admin/AdminPage'

export default function BacklinkPage() {
  const { crowi } = useContext(AdminContext)
  const [alert, setAlert] = useState({})

  const handleSubmit = async e => {
    e.preventDefault()

    try {
      await crowi.apiPost('/admin/backlink/build')

      setAlert({ message: 'Now re-building index ... this takes a while.', status: 'success', show: true })
    } catch ({ message }) {
      setAlert({ message, status: 'danger', show: true })
    } finally {
      setTimeout(() => setAlert({}), 5000)
    }
  }

  return (
    <form className="form-horizontal" role="form" onSubmit={handleSubmit}>
      <fieldset>
        <legend>Backlinks Build</legend>

        <Alert color={alert.status} isOpen={!!alert.show}>
          {alert.message}
        </Alert>

        <FormGroup>
          <Row>
            <Col xs={{ size: 3, offset: 1 }}>
              <Label>Backlinks Build</Label>
            </Col>
            <Col xs="7">
              <Button color="primary">Build Now</Button>
              <FormText color="muted">
                Force rebuild backlinks.<br />
                Click &quot;Build Now&quot; to delete all backlinks and create backlinks by all pages.<br />
                This may take a while.
              </FormText>
            </Col>
          </Row>
        </FormGroup>
      </fieldset>
    </form>
  )
}
