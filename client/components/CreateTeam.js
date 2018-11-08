import React from 'react'
import PropTypes from 'prop-types'

import { Modal, ModalHeader, ModalBody, ModalFooter, Form, FormGroup, Button, Label, Input } from 'reactstrap'

export default class CreateTeam extends React.Component {
  constructor(props) {
    super(props)
    this.crowi = this.props.crowi
  }

  render() {
    return (
      <Modal isOpen={this.props.isOpen} toggle={this.props.toggle} className="create-team">
        <Form>
          <ModalHeader>Create Team</ModalHeader>
          <ModalBody>
            <FormGroup>
              <Label>Name</Label>
              <Input />
            </FormGroup>
            <FormGroup>
              <Label>Handle</Label>
              <Input />
            </FormGroup>
            <FormGroup>
              <Label>Users</Label>
              <Input />
            </FormGroup>
          </ModalBody>
          <ModalFooter>
            <Button color="primary" onClick={this.props.toggle}>
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
  isOpen: PropTypes.bool.isRequired,
  toggle: PropTypes.func.isRequired,
}
