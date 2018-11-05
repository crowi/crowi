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
    console.dir(this.props.pageOwners)
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
              {['Unreal', 'Real', 'Incorp', 'Dev', 'Product', 'Wiki', 'Affairs'].sort().map(name => (
                <Label className="team" bsStyle="primary" key={name} onClick={this.handleRemove}>
                  <div className="icons">
                    <img src="/uploads/user/5bd3061a00ddf42a47165039.png" title="aaaa" />
                    <img src="/images/userpicture.png" title="Aoi Miyazaki" />
                  </div>
                  <span className="name">{name}</span>
                </Label>
              ))}
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
  pageOwners: PropTypes.object.isRequired,
}
