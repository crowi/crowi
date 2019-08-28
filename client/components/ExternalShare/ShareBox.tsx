import React from 'react'
import { withTranslation, WithTranslation } from 'react-i18next'
import { Button } from 'reactstrap'
import Icon from 'components/Common/Icon'
import ShareBoxContent from './ShareBoxContent'
import SettingModal from './SettingModal'
import AccessLogModal from './AccessLogModal'
import Crowi from 'client/util/Crowi'
import { Share } from 'client/types/crowi'

interface Props extends WithTranslation {
  isCreated?: boolean
  pageId: string | null
  crowi: Crowi
}

interface State {
  share: Share | null
  isChanging: boolean
  isCreated: boolean
  showSettingModal: boolean
  showAccessLogModal: boolean
  creationError: boolean
}

class ShareBox extends React.Component<Props, State> {
  static defaultProps = { isCreated: false }

  constructor(props: Props) {
    super(props)

    this.state = {
      share: null,
      isChanging: false,
      isCreated: !!props.isCreated,
      showSettingModal: false,
      showAccessLogModal: false,
      creationError: false,
    }

    this.updateLink = this.updateLink.bind(this)
    this.createLink = this.createLink.bind(this)
    this.deleteLink = this.deleteLink.bind(this)
    this.handleOpenSettingModal = this.handleOpenSettingModal.bind(this)
    this.handleCloseSettingModal = this.handleCloseSettingModal.bind(this)
    this.handleOpenAccessLogModal = this.handleOpenAccessLogModal.bind(this)
    this.handleCloseAccessLogModal = this.handleCloseAccessLogModal.bind(this)
  }

  async componentDidMount() {
    try {
      const { share } = await this.props.crowi.apiGet('/shares.get', { page_id: this.props.pageId })
      this.setState({ isCreated: true, share })
    } catch (err) {
      if (process.env.NODE_ENV === 'development') {
        console.error(err.message)
      }
    }
  }

  async updateLink(promise: Promise<{ share: Share }>) {
    const { isCreated } = this.state
    this.setState({ isChanging: true })
    try {
      const { share } = await promise
      this.setState({ isCreated: !isCreated, share })
      return null
    } catch (err) {
      return err
    } finally {
      this.setState({ isChanging: false })
    }
  }

  async createLink() {
    const { crowi, pageId } = this.props
    this.setState({ creationError: false })
    const error = await this.updateLink(crowi.apiPost('/shares.create', { page_id: pageId }))
    if (error !== null) {
      this.setState({ creationError: true })
    }
  }

  async deleteLink() {
    const { crowi, pageId } = this.props
    return this.updateLink(crowi.apiPost('/shares.delete', { page_id: pageId }))
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

  renderOpenAccessLogButton(handleOpen: () => void) {
    const { t } = this.props
    return (
      <Button onClick={handleOpen} outline color="secondary" size="sm">
        <Icon name="shoePrint" /> {t('share.watch_the_log')}
      </Button>
    )
  }

  render() {
    const { share, isCreated, isChanging, showSettingModal, showAccessLogModal, creationError } = this.state
    const { t, crowi, pageId } = this.props
    return (
      <div className="share-box">
        <div className="share-box-header">
          <h5>{t('share.share_to_external')}</h5>
          {this.renderOpenAccessLogButton(this.handleOpenAccessLogModal)}
        </div>
        <ShareBoxContent
          crowi={crowi}
          isCreated={isCreated}
          isChanging={isChanging}
          share={share}
          handleOpen={this.handleOpenSettingModal}
          handleCreate={this.createLink}
          creationError={creationError}
        />
        <SettingModal
          show={showSettingModal}
          onHide={this.handleCloseSettingModal}
          handleDelete={this.deleteLink}
          isChanging={isChanging}
          share={share}
          crowi={crowi}
        />
        {showAccessLogModal && <AccessLogModal show={showAccessLogModal} onHide={this.handleCloseAccessLogModal} pageId={pageId} crowi={crowi} />}
      </div>
    )
  }
}

export default withTranslation()(ShareBox)
