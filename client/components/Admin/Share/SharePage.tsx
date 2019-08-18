import React, { useContext, useState, FC } from 'react'
import { useTranslation } from 'react-i18next'
import { Alert, Button, FormGroup, CustomInput, Row, Col } from 'reactstrap'

import { AdminContext } from 'components/Admin/AdminPage'
import AdminShare from './AdminShare'

const SharePage: FC<{}> = () => {
  const [t] = useTranslation()
  const { crowi, loading, settingForm, fetchSettings } = useContext(AdminContext)
  const [alert, setAlert] = useState({ status: '', show: false, message: '' })
  const [externalShare, setExternalShare] = useState(Boolean(Number(settingForm['app:externalShare'])))

  const handleSubmit = async e => {
    e.preventDefault()

    try {
      await crowi.apiPost('/admin/settings/share', {
        settingForm: {
          'app:externalShare': externalShare ? '1' : '0',
        },
      })
      await fetchSettings()

      setAlert({ message: 'Updated', status: 'success', show: true })
    } catch ({ message }) {
      setAlert({ message, status: 'danger', show: true })
    } finally {
      setTimeout(() => setAlert({ status: '', show: false, message: '' }), 5000)
    }
  }

  return loading ? null : (
    <>
      <form className="form-horizontal" role="form" onSubmit={handleSubmit}>
        <fieldset>
          <legend>{t('admin.share.legend')}</legend>

          <Alert color={alert.status} isOpen={!!alert.show}>
            {alert.message}
          </Alert>

          <FormGroup>
            <Row>
              <Col xs={{ size: 10, offset: 1 }}>
                <CustomInput
                  type="checkbox"
                  id="appExternalShare"
                  label={t('admin.share.enable_external_share')}
                  checked={externalShare}
                  onChange={e => setExternalShare(!externalShare)}
                />
              </Col>
            </Row>
          </FormGroup>

          <FormGroup>
            <Row>
              <Col xs={{ size: 10, offset: 1 }}>
                <Button type="submit" color="primary">
                  {t('Save')}
                </Button>
              </Col>
            </Row>
          </FormGroup>
        </fieldset>
      </form>
      <AdminShare crowi={crowi} />
    </>
  )
}

export default SharePage
