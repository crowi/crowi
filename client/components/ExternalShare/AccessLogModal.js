import React from 'react'
import PropTypes from 'prop-types'
import { translate } from 'react-i18next'
import moment from 'moment'
import platform from 'platform'
import { Modal, Table, Alert } from 'react-bootstrap'
import Pagination from 'components/Common/Pagination'

class AccessLogModal extends React.Component {
  constructor(props) {
    super(props)

    moment.locale(navigator.userLanguage || navigator.language)

    this.state = {
      pageId: null,
      shares: [],
      pagination: {
        current: 0,
        count: 0,
        limit: 20,
      },
    }

    this.getPage = this.getPage.bind(this)
    this.movePage = this.movePage.bind(this)
    this.renderAccessLogTable = this.renderAccessLogTable.bind(this)
  }

  renderShareInfo(id, name, createdAt) {
    const { t } = this.props
    const date = moment(createdAt).format('llll')
    return (
      <div>
        <h4>共有ID: {id}</h4>
        <dl className="share-info">
          <div>
            <dt>{t('Author')}</dt>
            <dd>
              <a href={`/user/${name}`}>{name}</a>
            </dd>
          </div>
          <div>
            <dt>{t('Created')}</dt>
            <dd>{date}</dd>
          </div>
        </dl>
      </div>
    )
  }

  renderTableHeader() {
    const { t } = this.props
    return (
      <thead>
        <tr>
          <th>#</th>
          <th>{t('Browser')}</th>
          <th>OS</th>
          <th>{t('IP Address')}</th>
          <th>{t('Accessed')}</th>
        </tr>
      </thead>
    )
  }

  static renderTableBody(accesses, i) {
    const {
      tracking: { userAgent, remoteAddress },
      createdAt,
    } = accesses
    const index = i + 1
    const info = platform.parse(userAgent)
    const date = moment(createdAt).format('llll')
    return (
      <tr key={i}>
        <td>{index}</td>
        <td>{info.name}</td>
        <td>{info.os.toString()}</td>
        <td>{remoteAddress}</td>
        <td>{date}</td>
      </tr>
    )
  }

  renderAccessLogTable(share, i) {
    const { t } = this.props
    const {
      _id: id,
      creator: { name },
      createdAt,
      accesses,
    } = share
    return (
      <div key={i}>
        {this.renderShareInfo(id, name, createdAt)}
        {accesses.length > 0 ? (
          <Table bordered hover condensed>
            {this.renderTableHeader()}
            <tbody>{accesses.map(AccessLogModal.renderTableBody)}</tbody>
          </Table>
        ) : (
          <Alert color="info">{t('No one is accessing yet')}</Alert>
        )}
      </div>
    )
  }

  getPage(pageId, options = {}) {
    const limit = this.state.pagination.limit
    options = { ...options, limit: 5, page_id: pageId }
    this.props.crowi
      .apiGet('/shares.list', options)
      .then(({ share: { docs: shares, page: current, pages: count } }) => {
        const pagination = { current, count, limit }
        this.setState({ pageId, shares, pagination })
      })
      .catch(err => {
        console.log(err)
      })
  }

  movePage(i) {
    if (i !== this.state.pagination.current) {
      this.getPage(this.state.pageId, { page: i })
    }
  }

  componentDidMount() {
    const { pageId = null } = this.props
    if (pageId !== this.state.pageId) {
      this.getPage(pageId)
    }
  }

  componentDidUpdate() {
    const { pageId = null } = this.props
    if (pageId !== this.state.pageId) {
      this.getPage(pageId)
    }
  }

  renderPagination() {
    const { current, count } = this.state.pagination
    const range = [...Array(count).keys()]
    const items = range.map((v, k) => {
      const page = k + 1
      const className = page === current ? 'active' : ''
      return (
        <li key={page} className={className}>
          <a onClick={this.movePage(page)}>{page}</a>
        </li>
      )
    })
    return (
      <nav>
        <ul className="pagination">
          <li className={current === 1 ? 'disabled' : ''}>
            <a onClick={this.movePage(1)}>&laquo;</a>
          </li>
          {items}
          <li className={current === count ? 'disabled' : ''}>
            <a onClick={this.movePage(count)}>&raquo;</a>
          </li>
        </ul>
      </nav>
    )
  }

  render() {
    const { t, show, onHide } = this.props
    const {
      pagination: { current, count },
    } = this.state
    return (
      <Modal className="access-log-modal" show={show} onHide={onHide} bsSize="large">
        <Modal.Header closeButton>
          <Modal.Title id="contained-modal-title-lg">{t('Access Log')}</Modal.Title>
        </Modal.Header>
        <Modal.Body>
          {this.state.shares.map(this.renderAccessLogTable)}
          <Pagination current={current} count={count} onClick={this.movePage} />
        </Modal.Body>
      </Modal>
    )
  }
}

AccessLogModal.propTypes = {
  show: PropTypes.bool.isRequired,
  onHide: PropTypes.func.isRequired,
  pageId: PropTypes.string,
  t: PropTypes.func.isRequired,
  crowi: PropTypes.object.isRequired,
}

export default translate()(AccessLogModal)
