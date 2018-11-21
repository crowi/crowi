import React from 'react'
import PropTypes from 'prop-types'

import { Form, FormGroup, FormText, Button, Label } from 'reactstrap'
import CreateTeam from 'components/CreateTeam'
import FGInputAndHint from 'components/Common/FGInputAndHint'

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

    this.state = {
      // delete と add しかしないはずだからこれで問題が起きないはず。。。
      teams: { ...this.currentPageOwnerTeams },

      saveDisabled: false,

      createTeamModalOpened: false,
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

    const teamsWillDisown = Object.values(this.currentPageOwnerTeams).filter(team => !(team._id in this.state.teams))
    const teamsWillOwn = Object.values(this.state.teams).filter(team => !(team._id in this.currentPageOwnerTeams))

    const errors = []

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
