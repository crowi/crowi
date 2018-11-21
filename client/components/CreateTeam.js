import React from 'react'
import PropTypes from 'prop-types'

import { Modal, ModalHeader, ModalBody, ModalFooter, Form, FormText, FormGroup, Button, Label, Input } from 'reactstrap'

import FGInputAndHint from 'components/Common/FGInputAndHint'

export default class CreateTeam extends React.Component {
  constructor(props) {
    super(props)
    this.crowi = this.props.crowi

    this.state = {
      name: null,
      handle: null,
      users: {},

      // input
      actionDisabled: false,
    }

    const bindTargets = ['handleInputChange', 'create', 'calculateSuggestion', 'handleAdd', 'handleRemove', 'userHinter']
    bindTargets.forEach(name => {
      this[name] = this[name].bind(this)
    })
  }

  handleInputChange(key, event) {
    const value = event.target.value
    this.setState({
      [key]: value || null,
    })
  }

  handleAdd(userid) {
    this.setState(state => ({
      users: {
        ...state.users,
        [userid]: this.crowi.userById[userid],
      },
    }))
  }

  handleRemove(userid) {
    this.setState(state => {
      const { users } = state
      delete users[userid]
      return { users }
    })
  }

  calculateSuggestion(value) {
    if (!value) return [] // prevent empty

    const calculated = this.crowi.users.filter(user => {
      if (user._id in this.state.users) return false

      if (user.name.includes(value)) return true
      if ('name' in user && user.username.includes(value)) return true

      return false
    })

    return calculated
  }

  userHinter(input) {
    const users = this.calculateSuggestion(input)
    return users.map(user => [user._id, <span key={user._id}>@{user.username}</span>]).reduce((t, [k, v]) => {
      t[k] = v
      return t
    }, {})
  }

  async create() {
    this.setState({
      actionDisabled: true,
    })

    const { name, handle, users } = this.state
    const userids = Object.keys(users)

    await this.crowi.apiPost('/teams.create', {
      name,
      handle,
      userids,
    })

    // ライフサイクルが終わることを期待している
    this.props.toggle()

    // TODO: ここでキャッシュ期間をリセットする
  }

  render() {
    return (
      <Modal isOpen={true} toggle={this.props.toggle} className="create-team">
        <Form>
          <ModalHeader>Create Team</ModalHeader>
          <ModalBody>
            <FormGroup>
              <Label>Name</Label>
              <FormText className="float-right">{`eg. "Corporate Team"`}</FormText>
              <Input onChange={ev => this.handleInputChange('name', ev)} />
            </FormGroup>
            <FormGroup>
              <Label>Handle</Label>
              <FormText className="float-right">{`eg. "Corporate"`}</FormText>
              <Input onChange={ev => this.handleInputChange('handle', ev)} />
            </FormGroup>
            <FormGroup>
              <Label>Users</Label>
              <FGInputAndHint
                handleAdd={this.handleAdd}
                handleRemove={this.handleRemove}
                chosen={Object.values(this.state.users)
                  .map(v => [v._id, `@${v.username}`])
                  .reduce((o, [k, v]) => {
                    o[k] = v
                    return o
                  }, {})}
                hinter={this.userHinter}
                disabled={this.actionDisabled}
              />
            </FormGroup>
          </ModalBody>
          <ModalFooter>
            <Button color="primary" onClick={this.create}>
              Create
            </Button>
            <Button color="secondary" onClick={this.props.toggle}>
              Cancel
            </Button>
          </ModalFooter>
        </Form>
      </Modal>
    )
  }
}

CreateTeam.propTypes = {
  crowi: PropTypes.object.isRequired,
  toggle: PropTypes.func.isRequired,
}
