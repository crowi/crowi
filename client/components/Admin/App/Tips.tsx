import React, { ReactNode, FC } from 'react'
import { Card, CardBody, Row, Col } from 'reactstrap'

interface Props {
  children: ReactNode
}

const Tips: FC<Props> = ({ children }: Props) => {
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
