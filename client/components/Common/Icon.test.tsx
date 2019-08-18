import React from 'react'
import { shallow } from 'enzyme'
import Icon from './Icon'

describe('Icon', () => {
  describe('toPathName', () => {
    it('should convert icon name to path name', () => {
      const wrapper = shallow(<Icon name="account" />)
      const instance = wrapper.instance()

      expect(instance.toPathName('account')).toBe('mdiAccount')
      expect(instance.toPathName('account-alert')).toBe('mdiAccountAlert')
      expect(instance.toPathName('account-alert-outline')).toBe('mdiAccountAlertOutline')
    })
  })
})
