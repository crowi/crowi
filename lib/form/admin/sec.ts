import form from 'express-form'
import { stringToArrayFilter as stringToArray, normalizeCRLFFilter as normalizeCRLF } from 'server/util/formUtil'
const { field } = form

export default form(
  field('settingForm[security:basicName]'),
  field('settingForm[security:basicSecret]'),
  field('settingForm[security:registrationMode]').required(),
  field('settingForm[security:registrationWhiteList]').custom(normalizeCRLF).custom(stringToArray),
)
