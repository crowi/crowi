import React from 'react'
import PropTypes from 'prop-types'
import { translate } from 'react-i18next'
import { Button, InputGroup, Col, FormControl, FormGroup, HelpBlock } from 'react-bootstrap'

import Icon from 'components/Common/Icon'

class SecretKeywordFormContainer extends React.Component {
  constructor(props) {
    super(props)

    this.state = {
      secretKeyword: '',
      error: {
        status: false,
        message: '',
      },
      usingIME: true,
    }

    this.setSecretKeyword = this.setSecretKeyword.bind(this)
    this.canSubmit = this.canSubmit.bind(this)
    this.handleError = this.handleError.bind(this)
    this.checkSecretKeyword = this.checkSecretKeyword.bind(this)
    this.handleKeyPress = this.handleKeyPress.bind(this)
    this.handleSubmit = this.handleSubmit.bind(this)
    this.handleKeyUp = this.handleKeyUp.bind(this)
  }

  static propTypes = {
    t: PropTypes.func,
    pageId: PropTypes.string,
    crowi: PropTypes.object.isRequired,
  }

  setSecretKeyword(e) {
    this.setState({ error: { status: false }, secretKeyword: e.target.value })
  }

  canSubmit() {
    return this.state.secretKeyword.length > 0
  }

  handleError() {
    this.setState({ error: { status: true, message: this.props.t('Incorrect secret keyword') } })
  }

  checkSecretKeyword() {
    const { secretKeyword } = this.state
    const shareId = $('#secret-keyword-form-container').data('share-id')
    const _csrf = $('#secret-keyword-form-container').data('csrftoken')
    this.props.crowi
      .apiPost('/shares/secretKeyword.check', { _csrf, share_id: shareId, secret_keyword: secretKeyword })
      .then(({ hasAccessAuthority = false }) => {
        if (hasAccessAuthority) {
          this.setState({ error: { status: false } })
          top.location.href = '/_share/' + shareId
        } else {
          this.handleError()
        }
      })
      .catch(err => {
        console.log(err)
      })
  }

  isEnterAndNotUsingIME(e) {
    return e.keyCode == 13 && !this.state.usingIME
  }

  handleKeyPress(e) {
    // `onKeyPress` event is not triggered if using IME.
    this.setState({ usingIME: false })
  }

  handleKeyUp(e) {
    if (this.isEnterAndNotUsingIME(e)) {
      this.checkSecretKeyword()
    }
    this.setState({ usingIME: true })
  }

  handleSubmit(e) {
    this.checkSecretKeyword()
  }

  render() {
    const { t } = this.props
    const { error } = this.state
    return (
      <Col lg={4} md={6} sm={8} xs={10}>
        <h4 className="page-header">{t('Required secret keyword')}</h4>
        <div>
          <FormGroup controlId="secretKeyword" validationState={error.status ? 'error' : null}>
            <InputGroup>
              <InputGroup.Addon>
                <Icon name="key" />
              </InputGroup.Addon>
              <FormControl
                type="text"
                placeholder="Secret Keyword"
                onChange={this.setSecretKeyword}
                onKeyPress={this.handleKeyPress}
                onKeyUp={this.handleKeyUp}
              />
            </InputGroup>
            {error.status && <HelpBlock>{error.message}</HelpBlock>}
          </FormGroup>

          <FormGroup className="pull-right">
            <Button onClick={this.handleSubmit} disabled={!this.canSubmit()}>
              Submit
            </Button>
          </FormGroup>
        </div>
      </Col>
    )
  }
}

export default translate()(SecretKeywordFormContainer)
