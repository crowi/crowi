import React, { ReactElement, FC } from 'react'
import { Button, FormGroup, Label, Input, CustomInput, FormText, Row, Col } from 'reactstrap'

interface Props {
  children: ReactElement[] | ReactElement
}

const FormRow: FC<Props> = ({ children }: Props) => {
  const c = React.Children.toArray(children)
  const label = c.find(({ type }) => type === Label) || null
  const input = c.find(({ type }) => type === Input || type === CustomInput) || null
  const formText = c.find(({ type }) => type === FormText) || null
  const button = c.find(({ type }) => type === Button) || null

  return (
    <FormGroup>
      <Row>
        {label && <Col xs={{ size: 3, offset: 1 }}>{label}</Col>}
        <Col xs={{ size: 7, offset: label ? 0 : 4 }}>
          {input}
          {formText}
          {button}
        </Col>
      </Row>
    </FormGroup>
  )
}

export default FormRow
