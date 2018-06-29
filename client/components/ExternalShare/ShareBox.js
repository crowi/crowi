import React from 'react'
import PropTypes from 'prop-types'
import { Button } from 'react-bootstrap'
import Icon from '../Common/Icon'
import ShareBoxContent from './ShareBoxContent'
import SettingModal from './SettingModal'

const CreateButton = (isCreated, isChanging, handleCreate) =>
  !isCreated && (
    <Button onClick={handleCreate} bsStyle="primary" bsSize="small" disabled={isChanging}>
      <Icon name={isChanging ? 'spinner' : 'link'} spin={isChanging} />
      リンクを作成
    </Button>
  )

export default class ShareBox extends React.Component {
  constructor(props) {
    super(props)

    this.state = {
      shares: [],
      activeShare: {},
      isChanging: false,
      isCreated: props.isCreated,
      showModal: false,
    }

    this.updateLink = this.updateLink.bind(this)
    this.createLink = this.createLink.bind(this)
    this.deleteLink = this.deleteLink.bind(this)
    this.handleOpen = this.handleOpen.bind(this)
    this.handleClose = this.handleClose.bind(this)
  }

  componentDidMount() {
    this.props.crowi
      .apiGet('/shares.get', { page_id: this.props.pageId })
      .then(({ share }) => {
        this.setState({ share })
        const isActive = share => share.status === 'active'
        const activeShares = share.filter(isActive)
        const hasActive = activeShares.length > 0
        const activeShare = hasActive ? activeShares[0] : {}
        if (hasActive) {
          this.setState({ isCreated: true, activeShare })
        }
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
        this.setState({ isCreated: !isCreated, activeShare: share })
      })
      .catch(err => {
        alert(err.message)
      })
      .finally(() => {
        this.setState({ isChanging: false, showModal: false })
      })
  }

  createLink() {
    this.updateLink(this.props.crowi.apiPost('/shares.create', { page_id: this.props.pageId }))
  }

  deleteLink() {
    this.updateLink(this.props.crowi.apiPost('/shares.delete', { page_id: this.props.pageId }))
  }

  handleOpen() {
    this.setState({ showModal: true })
  }

  handleClose() {
    console.log('close modal')
    this.setState({ showModal: false })
  }

  render() {
    const { activeShare, isCreated, isChanging, showModal } = this.state
    return (
      <div className="share-box">
        <div className="share-box-header">
          <h5>外部に共有</h5>
          {CreateButton(isCreated, isChanging, this.createLink)}
        </div>
        <ShareBoxContent isCreated={isCreated} activeShare={activeShare} handleOpen={this.handleOpen} />
        <SettingModal
          show={showModal}
          handleClose={this.handleClose}
          handleDelete={this.deleteLink}
          isChanging={isChanging}
          activeShare={activeShare}
          crowi={this.props.crowi}
        />
      </div>
    )
  }
}

ShareBox.propTypes = {
  isCreated: PropTypes.bool,
  pageId: PropTypes.string,
  crowi: PropTypes.object.isRequired,
}
ShareBox.defaultProps = {
  isCreated: false,
}
