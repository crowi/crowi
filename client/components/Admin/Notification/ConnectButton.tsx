import React, { FC, useState } from 'react'
import Icon from 'components/Common/Icon'
import { Row, Col, Button, Modal, ModalHeader, ModalBody, ModalFooter } from 'reactstrap'

interface Props {
  hasSlackToken: boolean | null | undefined
  slackAuthUrl: string | null | undefined
  removeConfig: () => void
}

const ConnectButton: FC<Props> = ({ hasSlackToken, slackAuthUrl, removeConfig }) => {
  const url = slackAuthUrl || undefined
  const [modal, setModal] = useState(false)
  const toggle = () => setModal(!modal)

  return (
    <>
      <Modal isOpen={modal} toggle={toggle}>
        <ModalHeader toggle={toggle}>Confirm</ModalHeader>
        <ModalBody>Confirm remove configs and disconnect from Slack.</ModalBody>
        <ModalFooter>
          <Button
            color="danger"
            onClick={async () => {
              await removeConfig()
              setModal(false)
            }}
          >
            Disconnect
          </Button>
        </ModalFooter>
      </Modal>
      {hasSlackToken ? (
        <Row>
          <Col md={{ size: 12 }} className="text-center">
            <p>
              Crowi and Slack is already <strong>connected</strong>.You can re-connect to refresh and overwirte the token with your Slack account.
            </p>
          </Col>
          <Col md={{ size: 6, offset: 3 }} className="text-center">
            <Button color="secondary" href={url}>
              <Icon name="slack" /> Reconnect to Slack
            </Button>
          </Col>
          <Col md={2} className="text-right">
            <Button color="danger" onClick={() => setModal(true)}>
              Disconnect
            </Button>
          </Col>
        </Row>
      ) : (
        <Row>
          <Col md={{ size: 12 }} className="text-center">
            <p>Slack clientId and clientSecret is configured. Now, you can connect with Slack.</p>
          </Col>
          <Col md={{ size: 6, offset: 3 }} className="text-center">
            <Button color="primary" href={url}>
              <Icon name="slack" /> Connect to Slack
            </Button>
          </Col>
          <Col md={2} className="text-right">
            <Button color="danger" onClick={() => setModal(true)}>
              Disconnect
            </Button>
          </Col>
        </Row>
      )}
    </>
  )
}

export default ConnectButton
