import React from 'react'
import PropTypes from 'prop-types'
import { translate } from 'react-i18next'
import moment from 'moment'
import { Table, Alert } from 'reactstrap'
import Pagination from 'components/Common/Pagination'

class ShareList extends React.Component {
  constructor(props) {
    super(props)

    this.state = {
      shares: [],
      pagination: {
        current: 0,
        count: 0,
        limit: 20,
      },
      error: false,
    }

    this.getPage = this.getPage.bind(this)
    this.movePage = this.movePage.bind(this)
    this.renderTableBody = this.renderTableBody.bind(this)
  }

  async getPage(options = {}) {
    const limit = this.state.pagination.limit
    try {
      const { share } = await this.props.crowi.apiGet('/shares.list', { ...options, limit })
      const { docs: shares, page: current, pages: count } = share
      const pagination = { current, count, limit }
      this.setState({ shares, pagination })
    } catch (err) {
      this.setState({ error: true })
    }
  }

  movePage(i) {
    if (i !== this.state.pagination.current) {
      this.getPage({ page: i })
    }
  }

  componentDidMount() {
    this.getPage()
  }

  renderStatus(isActive) {
    const className = ['badge', isActive ? 'badge-success' : 'badge-danger'].join(' ')
    const text = isActive ? 'Active' : 'Inactive'
    return <span className={className}>{text}</span>
  }

  renderRecord({ index, path, username, name, date, isActive }) {
    return (
      <tr key={index}>
        <td>{index}</td>
        <td>
          <a href={path}>{path}</a>
        </td>
        <td>
          <a href={`/user/${username}`}>{name}</a>
        </td>
        <td>{date}</td>
        <td>{this.renderStatus(isActive)}</td>
      </tr>
    )
  }

  renderTableBody() {
    const { current, limit } = this.state.pagination
    const start = (current - 1) * limit + 1
    return (
      <tbody>
        {this.state.shares.map(({ page: { path }, creator: { username, name }, status, createdAt }, i) =>
          this.renderRecord({
            index: start + i,
            path,
            username,
            name,
            date: moment(createdAt).format('llll'),
            isActive: status === 'active',
          }),
        )}
      </tbody>
    )
  }

  render() {
    const { t } = this.props
    const {
      pagination: { current, count },
      error,
    } = this.state
    return error ? (
      <Alert color="danger">
        <p>{t('share_list.error.message')}</p>
      </Alert>
    ) : (
      <div>
        <Table bordered hover size="sm">
          <thead>
            <tr>
              <th>#</th>
              <th>{t('Page name')}</th>
              <th>{t('Creator')}</th>
              <th>{t('Created')}</th>
              <th>{t('Status')}</th>
            </tr>
          </thead>
          {this.renderTableBody()}
        </Table>
        <Pagination current={current} count={count} onClick={this.movePage} />
      </div>
    )
  }
}

ShareList.propTypes = {
  t: PropTypes.func.isRequired,
  pageId: PropTypes.string,
  crowi: PropTypes.object.isRequired,
}

export default translate()(ShareList)
