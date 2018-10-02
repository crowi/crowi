import React from 'react'
import PropTypes from 'prop-types'
import { translate } from 'react-i18next'
import moment from 'moment'
import platform from 'platform'
import { Table, Alert } from 'reactstrap'
import Pagination from 'components/Common/Pagination'

class AccessLog extends React.Component {
  constructor(props) {
    super(props)

    this.state = {
      accesses: [],
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
      const { shareAccess } = await this.props.crowi.apiGet('/shares/accesses.list', { ...options, limit })
      const { docs: accesses, page: current, pages: count } = shareAccess
      const pagination = { current, count, limit }
      this.setState({ accesses, pagination })
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

  renderRecord({ index, path, info, remoteAddress, date }) {
    return (
      <tr key={index}>
        <td>{index}</td>
        <td>
          <a href={path}>{path}</a>
        </td>
        <td>{info.name}</td>
        <td>{info.os.toString()}</td>
        <td>{remoteAddress}</td>
        <td>{date}</td>
      </tr>
    )
  }

  renderTableBody() {
    const { current, limit } = this.state.pagination
    const start = (current - 1) * limit + 1
    return (
      <tbody>
        {this.state.accesses.map(({ share: { page }, tracking: { userAgent, remoteAddress }, lastAccessedAt }, i) =>
          this.renderRecord({
            index: start + i,
            path: page.path,
            info: platform.parse(userAgent),
            remoteAddress,
            date: moment(lastAccessedAt).format('llll'),
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
        <p>{t('access_log.error.message')}</p>
      </Alert>
    ) : (
      <div>
        <Table bordered hover size="sm">
          <thead>
            <tr>
              <th>#</th>
              <th>{t('Page name')}</th>
              <th>{t('Browser')}</th>
              <th>OS</th>
              <th>{t('IP Address')}</th>
              <th>{t('Last Accessed')}</th>
            </tr>
          </thead>
          {this.renderTableBody()}
        </Table>
        <Pagination current={current} count={count} onClick={this.movePage} />
      </div>
    )
  }
}

AccessLog.propTypes = {
  t: PropTypes.func.isRequired,
  pageId: PropTypes.string,
  crowi: PropTypes.object.isRequired,
}

export default translate()(AccessLog)
