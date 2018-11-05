import React from 'react'
import PropTypes from 'prop-types'

import CreateTeam from 'components/CreateTeam'

import { FormGroup, InputGroup, HelpBlock, FormControl, Button, Badge, Label } from 'react-bootstrap'

export default class PageOwnerBox extends React.Component {
  constructor() {
    super()

    this.state = {
      value: null,
    }
  }

  render() {
    return (
      <div className="pageowner-setting-box">
        <h4>Add owners to this page</h4>

        <form>
          <FormGroup className="fg w-100">
            <div className="teams">
              <Label className="team" bsStyle="primary">
                <div className="icons">
                  <img src="/uploads/user/5bd3061a00ddf42a47165039.png" title="aaaa" />
                  <img src="/images/userpicture.png" title="Aoi Miyazaki" />
                </div>
                <span className="name">Team1</span>
              </Label>
              <Label className="team" bsStyle="primary">
                <div className="icons">
                  <img src="/uploads/user/5bd3061a00ddf42a47165039.png" title="aaaa" />
                  <img src="/images/userpicture.png" title="Aoi Miyazaki" />
                </div>
                <span className="name">Team1</span>
              </Label>
              <Label className="team" bsStyle="primary">
                <div className="icons">
                  <img src="/uploads/user/5bd3061a00ddf42a47165039.png" title="aaaa" />
                  <img src="/images/userpicture.png" title="Aoi Miyazaki" />
                </div>
                <span className="name">Team1</span>
              </Label>
            </div>
            <InputGroup className="w-100">
              <FormControl type="text" value={this.state.value} placeholder="Enter handle of team" />
              <InputGroup.Button>
                <Button>+</Button>
              </InputGroup.Button>
            </InputGroup>
            <HelpBlock className="mg-no">Create Team</HelpBlock>

            <Button
              className="pull-right"
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
}
