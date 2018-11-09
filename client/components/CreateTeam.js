import React from 'react'
import PropTypes from 'prop-types'

import { Modal, ModalHeader, ModalBody, ModalFooter, Badge, Form, FormText, FormGroup, Button, Label, Input } from 'reactstrap'

export default class CreateTeam extends React.Component {
  constructor(props) {
    super(props)
    this.crowi = this.props.crowi

    this.userInputRef = null

    this.state = {
      name: null,
      handle: null,
      users: {},

      // input
      userInputValue: '',
      actionDisabled: false,
    }

    const bindTargets = ['handleInputChange', 'create', 'calculateSuggestion', 'handleAdd', 'handleRemove']
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

  calculateSuggestion() {
    const value = this.state.userInputValue
    if (!value) return [] // prevent empty

    const calculated = this.crowi.users.filter(user => {
      if (user._id in this.state.users) return false

      if (user.name.includes(value)) return true
      if ('name' in user && user.username.includes(value)) return true

      return false
    })

    console.dir(this.crowi.users)
    console.dir(calculated)

    return calculated
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
            <FormGroup onClick={() => this.userInputRef.focus()}>
              <Label>Users</Label>
              <div className="users form-control w-100">
                {Object.values(this.state.users).map(user => {
                  return (
                    <Badge
                      className="user"
                      color="primary"
                      key={user._id}
                      onClick={event => {
                        event.preventDefault()
                        event.stopPropagation()
                        this.handleRemove(user._id)
                      }}
                    >
                      <span className="username">@{user.username}</span>
                    </Badge>
                  )
                })}
                <input
                  ref={ref => {
                    this.userInputRef = ref
                  }}
                  onChange={ev => this.handleInputChange('userInputValue', ev)}
                  onKeyPress={event => {
                    /* この処理は暫定で、サジェストができたらそっちで選ばせる */
                    if (event.key !== 'Enter') return

                    event.preventDefault()
                    event.stopPropagation()
                    console.log('aaa')
                    const calculated = this.calculateSuggestion()
                    console.dir(calculated)

                    if (calculated.length === 0) return
                    this.handleAdd(calculated[0]._id)
                    event.target.value = ''
                  }}
                />
              </div>
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
