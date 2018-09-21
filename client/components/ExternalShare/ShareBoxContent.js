// @flow
import React from 'react'
import { translate } from 'react-i18next'
import { Button, InputGroup, InputGroupAddon, Input, Alert } from 'reactstrap'
import Icon from 'components/Common/Icon'

type Props = {
  handleOpen?: Function,
  handleCreate?: Function,
  isCreated?: boolean,
  isChanging?: boolean,
  share: Object,
  creationError?: boolean,
  crowi: Object,
  t: Function,
}

class ShareBoxContent extends React.Component<Props> {
  static defaultProps = {
    isCreated: false,
    share: {},
  }

  inputRef: HTMLInputElement

  selectAction = e => {
    this.inputRef.select()
  }

  createRef = (node: HTMLInputElement) => {
    this.inputRef = node
  }

  copyAction = e => {
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

export default translate()(ShareBoxContent)
