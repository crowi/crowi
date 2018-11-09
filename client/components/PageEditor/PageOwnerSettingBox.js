import React from 'react'
import PropTypes from 'prop-types'

// import CreateTeam from 'components/CreateTeam'

import { Form, FormGroup, FormText, Button, Badge, Label } from 'reactstrap'
import CreateTeam from 'components/CreateTeam'

class Team {
  constructor(id, crowi) {
    this._id = id
    this._crowi = crowi
  }

  ownPage(pageId) {
    // TBD: URL は変わるはず
    return this._crowi.apiPost('/teams/ownPage', { id: this._id, page: pageId })
  }

  disownPage(pageId) {
    // TBD: URL は変わるはず
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

      createTeamModalOpened: false,
    }

    // handlers
    this.handleRemove = this.handleRemove.bind(this)
    this.handleAdd = this.handleAdd.bind(this)
    this.handleInput = this.handleInput.bind(this)
    this.save = this.save.bind(this)
    this.toggleCreateTeamModal = this.toggleCreateTeamModal.bind(this)
  }

  handleAdd(teamId) {
    this.setState(state => {
      const teams = {
        ...state.teams,
        [teamId]: this.crowi.teamById[teamId],
      }
      console.dir(teams)
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
  }

  toggleCreateTeamModal() {
    this.setState(state => ({
      createTeamModalOpened: !state.createTeamModalOpened,
    }))
  }

  calculateSuggestion() {
    const value = this.state.value
    if (!value) return [] // prevent empty

    const calculated = this.crowi.teams.filter(team => {
      if (team._id in this.state.teams) return false

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

    this.teamInputRef.value = ''
    this.setState({
      teamsWillOwn: {},
      teamsWillDisown: {},
      saveDisabled: false,
      value: '',
    })
  }

  render() {
    return (
      <div className="pageowner-setting-box">
        <h4>Add owners to this page</h4>

        <Form
          onSubmit={event => {
            event.preventDefault()
            event.stopPropagation()
            this.save(event)
          }}
        >
          <FormGroup className="fg-owners">
            <Label className="float-left">Owners</Label>
            <div className="teams form-control w-100" onClick={() => this.teamInputRef.focus()}>
              {Object.values(this.state.teams).map(team => {
                return (
                  <Badge
                    className="team"
                    color="primary"
                    key={team._id}
                    onClick={event => {
                      event.preventDefault()
                      event.stopPropagation()
                      this.handleRemove(team._id)
                    }}
                  >
                    <span className="name">#{team.handle}</span>
                  </Badge>
                )
              })}
              <input
                ref={ref => {
                  this.teamInputRef = ref
                }}
                onChange={this.handleInput}
                onKeyPress={event => {
                  if (event.key === 'Enter') {
                    event.preventDefault()
                    event.stopPropagation()
                    const calculated = this.calculateSuggestion()
                    if (calculated.length > 0) {
                      this.handleAdd(calculated[0]._id)
                      event.target.value = ''
                    }
                  }
                }}
              />
            </div>
          </FormGroup>
          {/* TODO: show below create-team on completion */}
          <FormText className="ft-create-team float-right">
            <a onClick={this.toggleCreateTeamModal}>Create Team</a>
          </FormText>
          {this.state.createTeamModalOpened && <CreateTeam toggle={this.toggleCreateTeamModal} crowi={this.crowi} />}
          <FormGroup className="fg-save">
            <Button type="submit" className="save float-right" disabled={this.state.saveDisabled}>
              Save
            </Button>
          </FormGroup>
        </Form>
      </div>
    )
  }
}

PageOwnerBox.propTypes = {
  crowi: PropTypes.object.isRequired,
  pageId: PropTypes.string.isRequired,
  currentPageOwners: PropTypes.array.isRequired,
}
