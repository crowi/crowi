import React, { useContext, useState, FC } from 'react'
import { useTranslation } from 'react-i18next'
import { Alert, Button, FormGroup, Label, FormText, Row, Col } from 'reactstrap'

import { AdminContext } from 'components/Admin/AdminPage'
import AdminRebuildSearch from './AdminRebuildSearch'

const SearchPage: FC<{}> = () => {
  const [t] = useTranslation()
  const { crowi } = useContext(AdminContext)
  const [alert, setAlert] = useState({ status: '', show: false, message: '' })

  const handleSubmit = async e => {
    e.preventDefault()

    try {
      await crowi.apiPost('/admin/search/build')

      setAlert({ message: 'Now re-building index ... this takes a while.', status: 'success', show: true })
    } catch ({ message }) {
      setAlert({ message, status: 'danger', show: true })
    } finally {
      setTimeout(() => setAlert({ status: '', show: false, message: '' }), 5000)
    }
  }

  return (
    <form className="form-horizontal" role="form" onSubmit={handleSubmit}>
      <fieldset>
        <legend>{t('admin.search.legend')}</legend>

        <Alert color={alert.status} isOpen={!!alert.show}>
          {alert.message}
        </Alert>

        <FormGroup>
          <Row>
            <Col xs={{ size: 3, offset: 1 }}>
              <Label>{t('admin.search.legend')}</Label>
            </Col>
            <Col xs="7">
              <AdminRebuildSearch crowi={crowi} />
              <Button type="submit" color="primary" className="mt-2">
                {t('admin.search.build')}
              </Button>
              <FormText color="muted">
                {t('admin.search.build_description1')}
                <br />
                {t('admin.search.build_description2')}
                <br />
                {t('admin.search.build_description3')}
              </FormText>
            </Col>
          </Row>
        </FormGroup>
      </fieldset>
    </form>
  )
}

export default SearchPage
