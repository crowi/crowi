// @flow
import React from 'react'
import { translate } from 'react-i18next'
import { Button, InputGroup, InputGroupAddon, InputGroupText, Col, Input, FormGroup, FormFeedback } from 'reactstrap'

import Icon from 'components/Common/Icon'

type Props = {
  t: Function,
  pageId?: string,
  crowi: Object,
}

type State = {
  secretKeyword: string,
  error: Object,
  usingIME: boolean,
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
  }

  setSecretKeyword = e => {
    this.setState({ error: { status: false }, secretKeyword: e.target.value })
  }

  canSubmit = () => {
    return this.state.secretKeyword.length > 0
  }

  handleError = () => {
    this.setState({ error: { status: true, message: this.props.t('Incorrect secret keyword') } })
  }

  checkSecretKeyword = async () => {
    const { secretKeyword } = this.state
    const shareId = $('#secret-keyword-form-container').data('share-id')
    const _csrf = $('#secret-keyword-form-container').data('csrftoken')
    try {
      const { hasAccessAuthority = false } = await this.props.crowi.apiPost('/shares/secretKeyword.check', {
        _csrf,
        share_id: shareId,
        secret_keyword: secretKeyword,
      })
      if (hasAccessAuthority) {
        this.setState({ error: { status: false } })
        top.location.href = '/_share/' + shareId
      } else {
        this.handleError()
      }
    } catch (err) {
      console.error(err)
    }
  }

  isEnterAndNotUsingIME(e) {
    return e.keyCode == 13 && !this.state.usingIME
  }

  handleKeyPress = e => {
    // `onKeyPress` event is not triggered if using IME.
    this.setState({ usingIME: false })
  }

  handleKeyUp = async e => {
    if (this.isEnterAndNotUsingIME(e)) {
      await this.checkSecretKeyword()
    }
    this.setState({ usingIME: true })
  }

  handleSubmit = e => {
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

export default translate()(SecretKeywordFormContainer)
