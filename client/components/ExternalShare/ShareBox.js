import React from 'react'
import PropTypes from 'prop-types'
import { Button } from 'react-bootstrap'
import Icon from '../Common/Icon'
import ShareBoxContent from './ShareBoxContent'
import SettingModal from './SettingModal'

function ActionButton(isCreated, isChanging, createAction, deleteAction) {
  const { button, icon, text, action } = isCreated
    ? {
        button: 'danger',
        icon: 'unlink',
        text: 'リンクを削除',
        action: deleteAction,
      }
    : {
        button: 'primary',
        icon: 'link',
        text: 'リンクを作成',
        action: createAction,
      }
  const iconName = isChanging ? 'spinner' : icon
  return (
    <Button onClick={action} bsStyle={button} bsSize="small" disabled={isChanging}>
      <Icon name={iconName} spin={isChanging} />
      {text}
    </Button>
  )
}

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
      .apiGet('/shares.list', { page_id: this.props.pageId })
      .then(({ share }) => {
        this.updateState({ share })
        const isActive = share => share.status === 'active'
        const activeShares = share.filter(isActive)
        const hasActive = activeShares.length > 0
        const activeShare = hasActive ? activeShares[0] : {}
        if (hasActive) {
          this.updateState({ isCreated: true, activeShare })
        }
      })
      .catch(err => {
        console.error(err)
      })
  }

  updateState(state) {
    const newState = Object.assign(this.state, state)
    this.setState(newState)
  }

  updateLink(promise) {
    const { isCreated } = this.state
    this.updateState({ isChanging: true })
    promise
      .then(({ share }) => {
        this.updateState({ isCreated: !isCreated, activeShare: share })
      })
      .catch(err => {
        alert(err.message)
      })
      .finally(() => {
        this.updateState({ isChanging: false })
      })
  }

  createLink(e) {
    this.updateLink(
      this.props.crowi.apiPost('/shares.create', {
        page_id: this.props.pageId,
      }),
    )
  }

  deleteLink(e) {
    this.updateLink(this.props.crowi.apiPost('/shares.delete', { page_id: this.props.pageId }))
  }

  handleOpen(e) {
    this.setState({ showModal: true })
  }

  handleClose(e) {
    this.setState({ showModal: false })
  }

  render() {
    const { activeShare, isCreated, isChanging, showModal } = this.state
    return (
      <div className="share-box">
        <div className="share-box-header">
          <h5>外部に共有</h5>
          {ActionButton(isCreated, isChanging, this.createLink, this.deleteLink)}
        </div>
        <ShareBoxContent isCreated={isCreated} activeShare={activeShare} handleOpen={this.handleOpen} />
        <SettingModal
          show={showModal}
          handleClose={this.handleClose}
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
