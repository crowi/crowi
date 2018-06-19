import React from 'react'
import PropTypes from 'prop-types'

import { Button, InputGroup, Col, ControlLabel, Form, FormControl, FormGroup } from 'react-bootstrap'

import Icon from '../../Common/Icon'

export default class SecretKeywordFormContainer extends React.Component {
  constructor(props) {
    super(props)

    this.state = {
      secretKeyword: '',
    }

    this.setSecretKeyword = this.setSecretKeyword.bind(this)
    this.canSubmit = this.canSubmit.bind(this)
    this.handleSubmit = this.handleSubmit.bind(this)
  }

  setSecretKeyword(e) {
    this.setState({ secretKeyword: e.target.value })
  }

  canSubmit() {
    return this.state.secretKeyword.length > 0
  }

  handleSubmit(e) {
    const { secretKeyword } = this.state
    const shareId = $('#secret-keyword-form-container').data('share-id')
    const _csrf = $('#secret-keyword-form-container').data('csrftoken')
    this.props.crowi
      .apiPost('/shares/secretKeyword.check', { _csrf, share_id: shareId, secret_keyword: secretKeyword })
      .then(({ hasAccessAuthority = false }) => {
        if (hasAccessAuthority) {
          top.location.href = '/_share/' + shareId
        }
      })
      .catch(err => {
        console.log(err)
      })
  }

  render() {
    return (
      <Col lg={4} md={6} sm={8} xs={10}>
        <h4 className="page-header">ページの閲覧には秘密のキーワードが必要です</h4>
        <div>
          <FormGroup controlId="secretKeyword">
            <InputGroup>
              <InputGroup.Addon>
                <Icon name="key" />
              </InputGroup.Addon>
              <FormControl type="text" placeholder="Secret Keyword" onChange={this.setSecretKeyword} />
            </InputGroup>
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

SecretKeywordFormContainer.propTypes = {
  pageId: PropTypes.string,
  crowi: PropTypes.object.isRequired,
}
