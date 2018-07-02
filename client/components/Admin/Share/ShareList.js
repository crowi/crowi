import React from 'react'
import PropTypes from 'prop-types'
import moment from 'moment'
import { Table } from 'react-bootstrap'
import Pagination from 'components/Common/Pagination'

export default class ShareList extends React.Component {
  constructor(props) {
    super(props)

    moment.locale(navigator.userLanguage || navigator.language)

    this.state = {
      shares: [],
      pagination: {
        current: 0,
        count: 0,
        limit: 20,
      },
    }

    this.getPage = this.getPage.bind(this)
    this.movePage = this.movePage.bind(this)
    this.renderTableBody = this.renderTableBody.bind(this)
  }

  getPage(options = {}) {
    const limit = this.state.pagination.limit
    options = { ...options, limit }
    this.props.crowi
      .apiGet('/shares.list', options)
      .then(({ share: { docs: shares, page: current, pages: count } }) => {
        const pagination = { current, count, limit }
        this.setState({ shares, pagination })
      })
      .catch(err => {
        console.log(err)
      })
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
    const className = ['label', isActive ? 'label-success' : 'label-danger'].join(' ')
    const text = isActive ? 'Active' : 'Inactive'
    return <span className={className}>{text}</span>
  }

  renderTableBody() {
    const { current, limit } = this.state.pagination
    const start = (current - 1) * limit + 1
    return (
      <tbody>
        {this.state.shares.map(({ page, creator, status, createdAt }, i) => {
          const index = start + i
          const { path } = page
          const { username } = creator
          const date = moment(createdAt).format('L')
          const isActive = status === 'active'
          return (
            <tr key={index}>
              <td>{index}</td>
              <td>{path}</td>
              <td>{username}</td>
              <td>{date}</td>
              <td>{this.renderStatus(isActive)}</td>
            </tr>
          )
        })}
      </tbody>
    )
  }

  render() {
    const {
      pagination: { current, count },
    } = this.state
    return (
      <div>
        <Table bordered hover condensed>
          <thead>
            <tr>
              <th>#</th>
              <th>ページ名</th>
              <th>作成者</th>
              <th>作成日時</th>
              <th>ステータス</th>
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
  pageId: PropTypes.string,
  crowi: PropTypes.object.isRequired,
}
