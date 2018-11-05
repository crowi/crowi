import React from 'react'
import PropTypes from 'prop-types'

// import CreateTeam from 'components/CreateTeam'

import { FormGroup, HelpBlock, Button, ControlLabel, Label } from 'react-bootstrap'

export default class PageOwnerBox extends React.Component {
  constructor(props) {
    super(props)

    this.teamInputRef = null
    this.state = {
      value: null,
    }

    this.handleRemove = this.handleRemove.bind(this)

    console.dir(this.props.crowi.teams)
    console.dir(this.props.currentPageOwners)
  }

  handleRemove(event) {
    event.preventDefault()
    event.stopPropagation()
  }

  render() {
    return (
      <div className="pageowner-setting-box">
        <h4>Add owners to this page</h4>

        <form>
          <FormGroup className="fg w-100">
            <ControlLabel className="w-100">Owners</ControlLabel>
            <div className="teams form-control" onClick={() => this.teamInputRef.focus()}>
              {this.props.currentPageOwners.map(owner => {
                const { team } = owner
                return (
                  <Label className="team" bsStyle="primary" key={team._id} onClick={this.handleRemove}>
                    <div className="icons">
                      {team.users.map(user => <img src={user.image || '/images/userpicture.png'} title={user.name} key={user._id} />)}
                    </div>
                    <span className="name">{team.name || team.handle}</span>
                  </Label>
                )
              })}
              <input
                ref={ref => {
                  this.teamInputRef = ref
                }}
              />
            </div>
            <HelpBlock>Create Team</HelpBlock> {/* TODO: show this on completion */}
            <Button
              className="pull-right save"
              onClick={() => {
                alert('do stuff')
              }}
            >
              Save
            </Button>
          </FormGroup>
        </form>
      </div>
    )
  }
}

PageOwnerBox.PropTypes = {
  crowi: PropTypes.object.isRequired,
  pageId: PropTypes.string.isRequired,
  currentPageOwners: PropTypes.object.isRequired,
}
