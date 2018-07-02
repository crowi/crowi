import React from 'react'
import PropTypes from 'prop-types'
import { translate } from 'react-i18next'
import { Button } from 'react-bootstrap'
import Icon from 'components/Common/Icon'
import ShareBoxContent from './ShareBoxContent'
import SettingModal from './SettingModal'
import AccessLogModal from './AccessLogModal'

class ShareBox extends React.Component {
  constructor(props) {
    super(props)

    this.state = {
      share: {},
      isChanging: false,
      isCreated: props.isCreated,
      showSettingModal: false,
      showAccessLogModal: false,
    }

    this.updateLink = this.updateLink.bind(this)
    this.createLink = this.createLink.bind(this)
    this.deleteLink = this.deleteLink.bind(this)
    this.handleOpenSettingModal = this.handleOpenSettingModal.bind(this)
    this.handleCloseSettingModal = this.handleCloseSettingModal.bind(this)
    this.handleOpenAccessLogModal = this.handleOpenAccessLogModal.bind(this)
    this.handleCloseAccessLogModal = this.handleCloseAccessLogModal.bind(this)
  }

  componentDidMount() {
    this.props.crowi
      .apiGet('/shares.get', { page_id: this.props.pageId })
      .then(({ share }) => {
        this.setState({ isCreated: true, share })
      })
      .catch(err => {
        console.error(err)
      })
  }

  async updateLink(promise) {
    const { isCreated } = this.state
    this.setState({ isChanging: true })
    return promise
      .then(({ share }) => {
        this.setState({ isCreated: !isCreated, share })
      })
      .catch(err => {
        alert(err.message)
      })
      .finally(() => {
        this.setState({ isChanging: false, showSettingModal: false })
      })
  }

  createLink() {
    this.updateLink(this.props.crowi.apiPost('/shares.create', { page_id: this.props.pageId }))
  }

  deleteLink() {
    this.updateLink(this.props.crowi.apiPost('/shares.delete', { page_id: this.props.pageId }))
  }

  handleOpenSettingModal() {
    this.setState({ showSettingModal: true })
  }

  handleCloseSettingModal() {
    this.setState({ showSettingModal: false })
  }

  handleOpenAccessLogModal() {
    this.setState({ showAccessLogModal: true })
  }

  handleCloseAccessLogModal() {
    this.setState({ showAccessLogModal: false })
  }

  renderCreateButton(isChanging, handleCreate) {
    const { t } = this.props
    return (
      <Button onClick={handleCreate} bsStyle="primary" bsSize="small" disabled={isChanging}>
        <Icon name={isChanging ? 'spinner' : 'link'} spin={isChanging} />
        {t('share.create_link')}
      </Button>
    )
  }

  renderOpenAccessLogButton(handleOpen) {
    const { t } = this.props
    return (
      <Button onClick={handleOpen} bsSize="small">
        <Icon name="list-alt" />
        {t('share.watch_the_log')}
      </Button>
    )
  }

  render() {
    const { share, isCreated, isChanging, showSettingModal, showAccessLogModal } = this.state
    const { t, crowi, pageId } = this.props
    return (
      <div className="share-box">
        <div className="share-box-header">
          <h5>{t('share.share_to_external')}</h5>
          {isCreated
            ? this.renderOpenAccessLogButton(this.handleOpenAccessLogModal)
            : this.renderCreateButton(isChanging, this.createLink)}
        </div>
        <ShareBoxContent isCreated={isCreated} share={share} handleOpen={this.handleOpenSettingModal} />
        <SettingModal
          show={showSettingModal}
          onHide={this.handleCloseSettingModal}
          handleDelete={this.deleteLink}
          isChanging={isChanging}
          share={share}
          crowi={crowi}
        />
        <AccessLogModal
          show={showAccessLogModal}
          onHide={this.handleCloseAccessLogModal}
          pageId={pageId}
          crowi={crowi}
        />
      </div>
    )
  }
}

ShareBox.propTypes = {
  isCreated: PropTypes.bool,
  pageId: PropTypes.string,
  t: PropTypes.func.isRequired,
  crowi: PropTypes.object.isRequired,
}
ShareBox.defaultProps = {
  isCreated: false,
}

export default translate()(ShareBox)
