import React from 'react'
import PropTypes from 'prop-types'

// import CreateTeam from 'components/CreateTeam'

import { FormGroup, HelpBlock, Button, ControlLabel, Label } from 'react-bootstrap'

class Team {
  constructor(id, crowi) {
    this._id = id
    this._crowi = crowi
  }

  ownPage(pageId) {
    return this._crowi.apiPost('/teams/ownPage', { id: this._id, page: pageId })
  }

  disownPage(pageId) {
    return this._crowi.apiPost('/teams/disownPage', { id: this._id, page: pageId })
  }
}

export default class PageOwnerBox extends React.Component {
  constructor(props) {
    super(props)

    this.crowi = this.props.crowi
    this.pageId = this.props.pageId
    this.currentPageOwnerTeams = this.props.currentPageOwners.map(owner => owner.team).reduce((result, team) => {
      result[team._id] = team
      return result
    }, {})

    this.teamInputRef = null

    this.state = {
      value: null,
      // delete と add しかしないはずだからこれで問題が起きないはず。。。
      teams: { ...this.currentPageOwnerTeams },

      saveDisabled: false,
    }

    // handlers
    this.handleRemove = this.handleRemove.bind(this)
    this.handleAdd = this.handleAdd.bind(this)
    this.handleInput = this.handleInput.bind(this)
    this.save = this.save.bind(this)

    console.dir(this.props.crowi.teams)
    console.dir(this.props.currentPageOwners)
  }

  handleAdd(teamId) {
    this.setState(state => {
      const { teams } = state

      teams[teamId] = this.crowi.teams[teamId]

      return {
        teams,
      }
    })
  }

  handleRemove(teamId) {
    this.setState(state => {
      const { teams } = state

      delete teams[teamId]

      return {
        teams,
      }
    })
  }

  handleInput(event) {
    const value = event.target.value
    this.setState({
      value: value || null,
    })
    // TODO: make this be called by render
    const calculated = this.calculateSuggestion(value)
    console.dir(calculated)
  }

  calculateSuggestion(value) {
    // TODO: get value from state
    // 今は handleInput から呼んでいて、どうも setState が効力を発揮する前らしい
    if (!value) return false // prevent empty

    const calculated = this.crowi.teams.filter(team => {
      if (team.handle.includes(value)) return true
      if ('name' in team && team.name.includes(value)) return true
      return false
    })
    return calculated
  }

  async save() {
    this.setState({
      saveDisabled: true,
    })

    const teamsWillDisown = Object.values(this.currentPageOwnerTeams).filter(team => !(team._id in this.state.teams))
    const teamsWillOwn = Object.values(this.state.teams).filter(team => !(team._id in this.currentPageOwnerTeams))

    const errors = []

    console.dir(teamsWillDisown)
    console.dir(teamsWillOwn)

    await Promise.all(
      [
        ...teamsWillOwn.map(id => new Team(id, this.crowi)).map(team => team.ownPage(this.pageId)),
        ...teamsWillDisown.map(id => new Team(id, this.crowi)).map(team => team.disownPage(this.pageId)),
      ].map(promise => promise.catch(e => errors.push(e))),
    )

    if (!errors) {
      console.error(errors)
    }

    this.setState({
      teamsWillOwn: {},
      teamsWillDisown: {},
      saveDisabled: false,
    })
  }

  render() {
    return (
      <div className="pageowner-setting-box">
        <h4>Add owners to this page</h4>

        <form>
          <FormGroup className="fg w-100">
            <ControlLabel className="w-100">Owners</ControlLabel>
            <div className="teams form-control" onClick={() => this.teamInputRef.focus()}>
              {Object.values(this.state.teams).map(team => {
                return (
                  <Label
                    className="team"
                    bsStyle="primary"
                    key={team._id}
                    onClick={event => {
                      event.preventDefault()
                      event.stopPropagation()
                      this.handleRemove(team._id)
                    }}
                  >
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
                onChange={this.handleInput}
              />
            </div>
            <HelpBlock>Create Team</HelpBlock> {/* TODO: show this on completion */}
            <Button className="pull-right save" onClick={this.save.bind(this)} disabled={this.state.saveDisabled}>
              Save
            </Button>
          </FormGroup>
        </form>
      </div>
    )
  }
}

PageOwnerBox.propTypes = {
  crowi: PropTypes.object.isRequired,
  pageId: PropTypes.string.isRequired,
  currentPageOwners: PropTypes.array.isRequired,
}
