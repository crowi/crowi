// FIXME: This file is not used from any components ...
import React from 'react'
import { withTranslation, WithTranslation } from 'react-i18next'
import { Button, InputGroup, InputGroupAddon, InputGroupText, Col, Input, FormGroup, FormFeedback } from 'reactstrap'

import Icon from 'components/Common/Icon'
import Crowi from 'client/util/Crowi'

interface Props extends WithTranslation {
  crowi: Crowi
}

interface State {
  secretKeyword: string
  error: {
    status: boolean
    message: string
  }
  usingIME: boolean
}

class SecretKeywordFormContainer extends React.Component<Props, State> {
  constructor(props: Props) {
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

  setSecretKeyword(e: React.ChangeEvent<HTMLInputElement>) {
    this.setState({ error: { status: false, message: '' }, secretKeyword: e.target.value })
  }

  canSubmit() {
    return this.state.secretKeyword.length > 0
  }

  handleError() {
    this.setState({ error: { status: true, message: this.props.t('Incorrect secret keyword') } })
  }

  async checkSecretKeyword() {
    const { secretKeyword } = this.state
    const shareId = $('#secret-keyword-form-container').data('share-id')
    const _csrf = window.APP_CONTEXT.csrfToken
    try {
      const { hasAccessAuthority = false } = await this.props.crowi.apiPost('/shares/secretKeyword.check', {
        _csrf,
        share_id: shareId,
        secret_keyword: secretKeyword,
      })
      if (hasAccessAuthority) {
        this.setState({ error: { status: false, message: '' } })
        top.location.href = '/_share/' + shareId
      } else {
        this.handleError()
      }
    } catch (err) {
      console.error(err)
    }
  }

  isEnterAndNotUsingIME(e: React.KeyboardEvent<HTMLInputElement>) {
    return e.keyCode == 13 && !this.state.usingIME
  }

  handleKeyPress(e: React.KeyboardEvent<HTMLInputElement>) {
    // `onKeyPress` event is not triggered if using IME.
    this.setState({ usingIME: false })
  }

  async handleKeyUp(e: React.KeyboardEvent<HTMLInputElement>) {
    if (this.isEnterAndNotUsingIME(e)) {
      await this.checkSecretKeyword()
    }
    this.setState({ usingIME: true })
  }

  handleSubmit() {
    this.checkSecretKeyword()
  }

  render() {
    const { t } = this.props
    const { error } = this.state
    return (
      <Col lg={4} md={6} sm={8} xs={10}>
        <h4 className="page-header">{t('Required secret keyword')}</h4>
        <div>
          <FormGroup>
            <InputGroup>
              <InputGroupAddon addonType="prepend">
                <InputGroupText>
                  <Icon name="key" />
                </InputGroupText>
              </InputGroupAddon>
              <Input
                placeholder="Secret Keyword"
                onChange={this.setSecretKeyword}
                onKeyPress={this.handleKeyPress}
                onKeyUp={this.handleKeyUp}
                invalid={error.status}
              />
              {error.status && <FormFeedback>{error.message}</FormFeedback>}
            </InputGroup>
          </FormGroup>

          <FormGroup>
            <Button className="d-block ml-auto" onClick={this.handleSubmit} disabled={!this.canSubmit()}>
              Submit
            </Button>
          </FormGroup>
        </div>
      </Col>
    )
  }
}

export default withTranslation()(SecretKeywordFormContainer)
