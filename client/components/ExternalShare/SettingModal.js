import React from 'react'
import PropTypes from 'prop-types'
import { translate } from 'react-i18next'
import Icon from 'components/Common/Icon'
import DeleteConfirmModal from './DeleteConfirmModal'
import { Button, Container, Row, Col, Label, Input, CustomInput, Modal, ModalHeader, ModalBody, ModalFooter } from 'reactstrap'

class SettingModal extends React.Component {
  constructor(props) {
    super(props)

    this.state = {
      shareId: null,
      secretKeyword: null,
      restricted: false,
      showConfirmModal: false,
      result: {
        show: false,
        error: false,
        message: '',
      },
    }

    this.setRestricted = this.setRestricted.bind(this)
    this.setSecretKeyword = this.setSecretKeyword.bind(this)
    this.handleSubmit = this.handleSubmit.bind(this)
    this.handleOpen = this.handleOpen.bind(this)
    this.handleClose = this.handleClose.bind(this)
    this.handleCloseAll = this.handleCloseAll.bind(this)
    this.renderResult = this.renderResult.bind(this)
  }

  componentDidUpdate() {
    const { share = {} } = this.props
    const { uuid: shareId, secretKeyword = '' } = share

    if (shareId !== this.state.shareId) {
      this.setState({
        shareId,
        secretKeyword,
        restricted: !!secretKeyword,
      })
    }
  }

  setRestricted(value) {
    return () => {
      this.setState({ restricted: value })
    }
  }

  setSecretKeyword(e) {
    this.setState({ secretKeyword: e.target.value })
  }

  canSubmit() {
    const { restricted, secretKeyword } = this.state
    if (!restricted) {
      return true
    }
    return !!secretKeyword && secretKeyword.length > 0
  }

  async handleSubmit() {
    const { shareId, secretKeyword, restricted } = this.state
    try {
      await this.props.crowi.apiPost('/shares/secretKeyword.set', {
        share_id: shareId,
        secret_keyword: restricted ? secretKeyword : null,
      })
      this.setState({ result: { show: true, error: false, message: this.props.t('share.setting.saved') } })
      setTimeout(() => this.setState({ result: { show: false } }), 1000)
    } catch (err) {
      this.setState({ result: { show: true, error: true, message: this.props.t('share.setting.error.message') } })
    }
  }

  handleOpen() {
    this.setState({ showConfirmModal: true })
  }

  handleClose() {
    this.setState({ showConfirmModal: false })
  }

  handleCloseAll() {
    const { onHide } = this.props
    onHide()
    this.handleClose()
  }

  renderResult() {
    const {
      result: { show, error, message },
    } = this.state
    return (
      show && (
        <div
          style={{
            display: 'inline-block',
            marginRight: 20,
          }}
        >
          <span className={error ? 'text-danger' : 'text-success'}>{message}</span>
        </div>
      )
    )
  }

  render() {
    const { t, show, onHide, isChanging, handleDelete } = this.props
    const { restricted, secretKeyword, showConfirmModal } = this.state
    return (
      <Modal className="share-setting-modal" isOpen={show} toggle={onHide}>
        <ModalHeader toggle={onHide}>{t('share.link_settings')}</ModalHeader>
        <ModalBody>
          <Container>
            <Row>
              <Col sm={2}>
                <Label>{t('share.setting.restrict_access')}</Label>
              </Col>
              <Col sm={10}>
                <CustomInput
                  type="radio"
                  id="not_restricted"
                  name="restricted"
                  onClick={this.setRestricted(false)}
                  defaultChecked={!restricted}
                  label={t('share.setting.people_who_know_this_link')}
                />
                {}
                <CustomInput
                  type="radio"
                  id="restricted"
                  name="restricted"
                  onClick={this.setRestricted(true)}
                  defaultChecked={restricted}
                  label={t('share.setting.people_who_know_this_secret_keyword')}
                />
                {restricted && (
                  <Input
                    className="secret-keyword"
                    placeholder={t('share.setting.secret_keyword')}
                    onChange={this.setSecretKeyword}
                    defaultValue={secretKeyword}
                  />
                )}
              </Col>
            </Row>
          </Container>
          <DeleteConfirmModal show={showConfirmModal} onHide={this.handleClose} handleClose={this.handleCloseAll} handleDelete={handleDelete} />
        </ModalBody>
        <ModalFooter>
          <Button className="mr-auto" onClick={this.handleOpen} color="danger" disabled={isChanging}>
            <Icon name={isChanging ? 'spinner' : 'unlink'} spin={isChanging} />
            {t('share.delete_link')}
          </Button>
          {this.renderResult()}
          <Button onClick={this.handleSubmit} color="primary" disabled={!this.canSubmit()}>
            {t('share.setting.save_settings')}
          </Button>
        </ModalFooter>
      </Modal>
    )
  }
}

SettingModal.propTypes = {
  share: PropTypes.object,
  show: PropTypes.bool.isRequired,
  onHide: PropTypes.func.isRequired,
  isChanging: PropTypes.bool,
  handleDelete: PropTypes.func,
  t: PropTypes.func.isRequired,
  crowi: PropTypes.object.isRequired,
}
SettingModal.defaultProps = {
  show: false,
}

export default translate()(SettingModal)
