import React from 'react'
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

export default Tips
