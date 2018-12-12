import React from 'react'
import PropTypes from 'prop-types'

import { Form, FormGroup, FormText, Button, Label, Alert } from 'reactstrap'
import CreateTeam from 'components/CreateTeam'
import FGInputAndHint from 'components/Common/FGInputAndHint'

class PageOwner {
  constructor(crowi) {
    this._crowi = crowi
  }

  activate(teamId, pageId) {
    return this._crowi.apiPost('/page_owners.activate', { team: teamId, page: pageId })
  }

  deactivate(teamId, pageId) {
    return this._crowi.apiPost('/page_owners.deactivate', { team: teamId, page: pageId })
  }
}

export default class PageOwnerBox extends React.Component {
  constructor(props) {
    super(props)

    this.crowi = this.props.crowi
    this.pageId = this.props.pageId
    const currentPageOwnerTeams = this.props.currentPageOwners.map(owner => owner.team).reduce((result, team) => {
      result[team._id] = team
      return result
    }, {})

    this.state = {
      // delete と add しかしないはずだからこれで問題が起きないはず。。。
      previousTeams: { ...currentPageOwnerTeams },
      teams: { ...currentPageOwnerTeams },

      saveDisabled: false,

      createTeamModalOpened: false,
      error: null,
    }

    // handlers
    this.handleRemove = this.handleRemove.bind(this)
    this.handleAdd = this.handleAdd.bind(this)
    this.save = this.save.bind(this)
    this.toggleCreateTeamModal = this.toggleCreateTeamModal.bind(this)
    this.hinter = this.hinter.bind(this)
  }

  handleAdd(teamId) {
    this.setState(state => {
      const teams = {
        ...state.teams,
        [teamId]: this.crowi.teamById[teamId],
      }
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

  toggleCreateTeamModal() {
    this.setState(state => ({
      createTeamModalOpened: !state.createTeamModalOpened,
    }))
  }

  calculateSuggestion(value) {
    if (!value) return [] // prevent empty

    const calculated = this.crowi.teams.filter(team => {
      if (team._id in this.state.teams) return false

      if (team.handle.includes(value)) return true
      if ('name' in team && team.name.includes(value)) return true

      return false
    })
    return calculated
  }

  hinter(input) {
    const teams = this.calculateSuggestion(input)
    return teams.map(team => [team._id, <span key={team._id}>#{team.handle}</span>]).reduce((t, [k, v]) => {
      t[k] = v
      return t
    }, {})
  }

  async save() {
    this.setState({
      saveDisabled: true,
    })

    const teamsWillActivated = Object.values(this.state.teams).filter(team => !(team._id in this.state.previousTeams))
    const teamsWillDeactivated = Object.values(this.state.previousTeams).filter(team => !(team._id in this.state.teams))

    const errors = []

    const po = new PageOwner(this.crowi)
    await Promise.all(
      [...teamsWillActivated.map(team => po.activate(team._id, this.pageId)), ...teamsWillDeactivated.map(team => po.deactivate(team._id, this.pageId))].map(
        promise => promise.catch(e => errors.push(e)),
      ),
    )

    let error = null

    if (!errors) {
      error = errors.map(error => error.message).join(', ')
    }

    this.setState(state => ({
      error,
      saveDisabled: false,
      previousTeams: { ...state.teams },
    }))
  }

  render() {
    return (
      <div className="pageowner-setting-box">
        <h4>Add owners to this page</h4>

        {this.state.error && <Alert color="danger">{this.state.error}</Alert>}

        <Form
          onSubmit={event => {
            event.preventDefault()
            event.stopPropagation()
            this.save(event)
          }}
        >
          <FormGroup>
            <Label className="justify-content-start flex-grow-1">Owners</Label>
            <FormText>
              <a className="p-0" onClick={this.toggleCreateTeamModal}>
                Create Team
              </a>
            </FormText>
            <FGInputAndHint
              handleAdd={this.handleAdd}
              handleRemove={this.handleRemove}
              chosen={Object.values(this.state.teams)
                .map(v => [v._id, `#${v.handle}`])
                .reduce((t, [k, v]) => {
                  t[k] = v
                  return t
                }, {})}
              hinter={this.hinter}
            />
          </FormGroup>
          {this.state.createTeamModalOpened && <CreateTeam toggle={this.toggleCreateTeamModal} crowi={this.crowi} />}
          <FormGroup className="fg-save justify-content-end">
            <Button type="submit" className="save" disabled={this.state.saveDisabled}>
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
