import React, { useContext, useState } from 'react'
import { Alert, Button, FormGroup, Label, FormText, Row, Col } from 'reactstrap'

import { AdminContext } from 'components/Admin/AdminPage'
import AdminRebuildSearch from './AdminRebuildSearch'

export default function SearchPage() {
  const { crowi } = useContext(AdminContext)
  const [alert, setAlert] = useState({})

  const handleSubmit = async e => {
    e.preventDefault()

    try {
      await crowi.apiPost('/admin/search/build')

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
        <legend>Index Build</legend>

        <Alert color={alert.status} isOpen={!!alert.show}>
          {alert.message}
        </Alert>

        <FormGroup>
          <Row>
            <Col xs={{ size: 3, offset: 1 }}>
              <Label>Index Build</Label>
            </Col>
            <Col xs="7">
              <AdminRebuildSearch crowi={crowi} />
              <Button type="submit" color="primary" className="mt-2">
                Build Now
              </Button>
              <FormText color="muted">
                Force rebuild index.<br />
                Click "Build Now" to delete and create mapping file and add all pages.<br />
                This may take a while.
              </FormText>
            </Col>
          </Row>
        </FormGroup>
      </fieldset>
    </form>
  )
}
