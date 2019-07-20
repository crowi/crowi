import React from 'react'
import PropTypes from 'prop-types'
import { Card, CardBody, Row, Col } from 'reactstrap'

function Tips({ children }) {
  return (
    <Row>
      <Col xs={{ size: 10, offset: 1 }} className="mb-4">
        <Card>
          <CardBody className="bg-light">{children}</CardBody>
        </Card>
      </Col>
    </Row>
  )
}

Tips.propTypes = {
  children: PropTypes.node,
}

export default Tips
