import React from 'react'
import { withTranslation, WithTranslation } from 'react-i18next'
import { Button, InputGroup, InputGroupAddon, Input, Alert } from 'reactstrap'
import Icon from 'components/Common/Icon'
import Crowi from 'client/util/Crowi'
import { Share } from 'client/types/crowi'

interface Props extends WithTranslation {
  handleOpen?: () => void
  handleCreate?: () => void
  isCreated?: boolean
  isChanging?: boolean
  share: Share | null
  creationError?: boolean
  crowi: Crowi
}

class ShareBoxContent extends React.Component<Props> {
  static defaultProps = { isCreated: false }

  inputRef?: HTMLInputElement

  constructor(props: Props) {
    super(props)

    this.selectAction = this.selectAction.bind(this)
    this.createRef = this.createRef.bind(this)
    this.copyAction = this.copyAction.bind(this)
  }

  selectAction() {
    if (this.inputRef) {
      this.inputRef.select()
    }
  }

  createRef(node: HTMLInputElement) {
    this.inputRef = node
  }

  copyAction() {
    if (this.inputRef) {
      this.inputRef.select()
      document.execCommand('copy')
    }
  }

  render() {
    const { t, crowi, share, isCreated, isChanging, handleOpen, handleCreate, creationError } = this.props
    if (isCreated && share) {
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
          <Icon name={isChanging ? 'loading' : 'link'} spin={isChanging} /> {t('share.create_link')}
        </Button>
      </div>
    )
  }
}

export default withTranslation()(ShareBoxContent)
