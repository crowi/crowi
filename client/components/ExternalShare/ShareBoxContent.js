import React from 'react'
import PropTypes from 'prop-types'
import { translate } from 'react-i18next'
import { Button, InputGroup, FormControl } from 'react-bootstrap'

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
    const { t, share, isCreated, handleOpen } = this.props
    if (isCreated) {
      const shareId = share.id
      const url = `${location.origin}/_share/${shareId}`
      return (
        <div className="share-box-content">
          <InputGroup>
            <FormControl
              bsClass="copy-link form-control"
              type="text"
              defaultValue={url}
              readOnly
              onClick={this.selectAction}
              inputRef={this.createRef}
            />
            <InputGroup.Button onClick={this.copyAction}>
              <Button>Copy</Button>
            </InputGroup.Button>
          </InputGroup>
          <Button className="pull-right" onClick={handleOpen}>
            {t('share.link_settings')}
          </Button>
        </div>
      )
    }
    return <div className="share-box-content">{t('share.no_link_has_been_created_yet')}</div>
  }
}

ShareBoxContent.propTypes = {
  handleOpen: PropTypes.func,
  isCreated: PropTypes.bool,
  share: PropTypes.object,
  t: PropTypes.func.isRequired,
}
ShareBoxContent.defaultProps = {
  isCreated: false,
  share: {},
}

export default translate()(ShareBoxContent)
