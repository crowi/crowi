import React from 'react'
import PropTypes from 'prop-types'
import { translate } from 'react-i18next'
import { Button, InputGroup, InputGroupAddon, Input, Alert } from 'reactstrap'
import Icon from 'components/Common/Icon'

class ShareBoxContent extends React.Component {
  constructor(props) {
    super(props)

    this.selectAction = this.selectAction.bind(this)
    this.createRef = this.createRef.bind(this)
    this.copyAction = this.copyAction.bind(this)
  }

  selectAction(e) {
    this.inputRef.select()
  }

  createRef(node) {
    this.inputRef = node
  }

  copyAction(e) {
    this.inputRef.select()
    document.execCommand('copy')
  }

  render() {
    const { t, crowi, share, isCreated, isChanging, handleOpen, handleCreate, creationError } = this.props
    if (isCreated) {
      const shareId = share.uuid
      const url = `${crowi.location.origin}/_share/${shareId}`
      return (
        <div className="share-box-content">
          <InputGroup>
            <Input className="copy-link" defaultValue={url} readOnly onClick={this.selectAction} innerRef={this.createRef} />
            <InputGroupAddon addonType="append">
              <Button onClick={this.copyAction}>Copy</Button>
            </InputGroupAddon>
          </InputGroup>
          <Button className="d-block ml-auto" onClick={handleOpen}>
            {t('share.link_settings')}
          </Button>
        </div>
      )
    }
    return (
      <div className="share-box-content">
        {creationError && <Alert color="danger">{t('share.error.can_not_create')}</Alert>}
        <p>{t('share.no_link_has_been_created_yet')}</p>
        <Button className="d-block ml-auto" color="primary" onClick={handleCreate} disabled={isChanging}>
          <Icon name={isChanging ? 'spinner' : 'link'} spin={isChanging} />
          {t('share.create_link')}
        </Button>
      </div>
    )
  }
}

ShareBoxContent.propTypes = {
  handleOpen: PropTypes.func,
  handleCreate: PropTypes.func,
  isCreated: PropTypes.bool,
  isChanging: PropTypes.bool,
  share: PropTypes.object,
  creationError: PropTypes.bool,
  crowi: PropTypes.object.isRequired,
  t: PropTypes.func.isRequired,
}
ShareBoxContent.defaultProps = {
  isCreated: false,
  share: {},
}

export default translate()(ShareBoxContent)
