import { createExpressEndpoints, initServer } from '@ts-rest/express';
import { apiContract } from '@crowi/api-contract';
import Crowi from 'src/crowi';
import { Express, Router, Request, Response } from 'express';
import multer from 'multer';
import fs from 'fs';
import FileUploader from 'src/util/fileUploader';
import Debug from 'debug';
import { UserDocument } from 'src/models/user';

const debug = Debug('crowi:routes:ts-rest:me');

export default (crowi: Crowi, _app: Express) => {
  const s = initServer();
  const router = Router();
  const User = crowi.model('User');

  // Configure multer for file uploads
  const upload = multer({ dest: crowi.tmpDir });

  // Helper function to convert user document to profile response
  const userToProfileResponse = (user: UserDocument, hasPassword: boolean) => ({
    id: user._id.toString(),
    username: user.username,
    name: user.name,
    email: user.email,
    lang: user.lang,
    image: user.image,
    introduction: user.introduction || undefined,
    googleId: user.googleId,
    githubId: user.githubId,
    hasPassword,
    createdAt: user.createdAt.toISOString(),
  });

  const meRouter = s.router(apiContract.me, {
    getProfile: async ({ req }) => {
      const user = req.user as UserDocument;

      // Check if user has password set
      const userWithSecrets = await user.populateSecrets();
      const hasPassword = userWithSecrets.isPasswordSet();

      return {
        status: 200 as const,
        body: userToProfileResponse(user, hasPassword),
      };
    },

    updateProfile: async ({ body, req }) => {
      const user = req.user as UserDocument;
      const { name, email, lang } = body.userForm;

      // Check if email is valid (whitelist check)
      if (!User.isEmailValid(email)) {
        return {
          status: 400 as const,
          body: {
            status: 'error' as const,
            message: "You can't update to that email address",
            errors: ["You can't update to that email address"],
          },
        };
      }

      // Check for duplicate email
      const existingUser = await User.findOne({ email });
      if (existingUser && !existingUser._id.equals(user._id)) {
        debug('Email address was duplicated');
        return {
          status: 400 as const,
          body: {
            status: 'error' as const,
            message: 'It can not be changed to that mail address',
            errors: ['It can not be changed to that mail address'],
          },
        };
      }

      try {
        // Update user fields
        user.name = name;
        user.email = email;
        user.lang = lang;
        await user.save();

        // Check if user has password set
        const userWithSecrets = await user.populateSecrets();
        const hasPassword = userWithSecrets.isPasswordSet();

        return {
          status: 200 as const,
          body: userToProfileResponse(user, hasPassword),
        };
      } catch (err) {
        const error = err as { errors?: Record<string, { message: string }> };
        const errorMessages: string[] = [];
        if (error.errors) {
          Object.keys(error.errors).forEach((e) => {
            errorMessages.push(error.errors![e].message);
          });
        } else {
          errorMessages.push('Failed to update profile');
        }

        return {
          status: 400 as const,
          body: {
            status: 'error' as const,
            message: errorMessages[0],
            errors: errorMessages,
          },
        };
      }
    },

    uploadPicture: async ({ req, res }) => {
      return new Promise((resolve) => {
        const user = req.user as UserDocument;
        const fileUploader = FileUploader(crowi);

        // Handle file upload with multer
        upload.single('file')(req as Request, res as Response, async (err) => {
          if (err) {
            debug('Multer error:', err);
            return resolve({
              status: 400 as const,
              body: {
                status: 'error' as const,
                message: 'File upload error.',
                errors: ['File upload error.'],
              },
            });
          }

          const tmpFile = (req as Request).file || null;
          if (!tmpFile) {
            return resolve({
              status: 400 as const,
              body: {
                status: 'error' as const,
                message: 'No file provided.',
                errors: ['No file provided.'],
              },
            });
          }

          const tmpPath = tmpFile.path;
          const name = tmpFile.filename + tmpFile.originalname;
          const ext = name.match(/(.*)(?:\.([^.]+$))/)?.[2] || '';
          const filePath = User.createUserPictureFilePath(user, ext);
          const acceptableFileType = /image\/.+/;

          if (!tmpFile.mimetype.match(acceptableFileType)) {
            // Clean up temp file
            fs.unlink(tmpPath, () => {});
            return resolve({
              status: 400 as const,
              body: {
                status: 'error' as const,
                message: 'File type error. Only image files is allowed to set as user picture.',
                errors: ['File type error. Only image files is allowed to set as user picture.'],
              },
            });
          }

          const tmpFileStream = fs.createReadStream(tmpPath, {
            flags: 'r',
            mode: 0o666,
            autoClose: true,
          });

          try {
            await fileUploader.uploadFile(filePath, tmpFile.mimetype, tmpFileStream, {});
            const imageUrl = fileUploader.generateUrl(filePath);

            // Update user image
            await new Promise<void>((resolveUpdate, rejectUpdate) => {
              user.updateImage(imageUrl, (updateErr: Error | null) => {
                if (updateErr) {
                  rejectUpdate(updateErr);
                } else {
                  resolveUpdate();
                }
              });
            });

            // Clean up temp file
            fs.unlink(tmpPath, (unlinkErr) => {
              if (unlinkErr) {
                debug('Error while deleting tmp file.', unlinkErr);
              }
            });

            return resolve({
              status: 200 as const,
              body: {
                status: true,
                url: imageUrl,
                message: '',
              },
            });
          } catch (uploadErr) {
            debug('Uploading error', uploadErr);
            // Clean up temp file
            fs.unlink(tmpPath, () => {});
            return resolve({
              status: 400 as const,
              body: {
                status: 'error' as const,
                message: 'Error while uploading file',
                errors: ['Error while uploading file'],
              },
            });
          }
        });
      });
    },

    deletePicture: async ({ req }) => {
      return new Promise((resolve) => {
        const user = req.user as UserDocument;

        // Delete user image
        // TODO: Also delete from S3/storage
        user.deleteImage((err: Error | null) => {
          if (err) {
            debug('Error deleting image:', err);
            return resolve({
              status: 400 as const,
              body: {
                status: 'error' as const,
                message: 'Failed to delete profile picture',
                errors: ['Failed to delete profile picture'],
              },
            });
          }

          return resolve({
            status: 200 as const,
            body: {
              status: 'ok' as const,
              message: 'Deleted profile picture',
            },
          });
        });
      });
    },

    updatePassword: async ({ body, req }) => {
      const user = req.user as UserDocument;
      const { oldPassword, newPassword, newPasswordConfirm } = body;

      // Check if email is set (required for password setting)
      if (!user.isEmailSet()) {
        return {
          status: 400 as const,
          body: {
            status: 'error' as const,
            message: 'Email must be set before setting password',
            errors: ['Email must be set before setting password'],
          },
        };
      }

      // Get user with password field populated for validation
      const userWithSecrets = await user.populateSecrets();
      const hasPassword = userWithSecrets.isPasswordSet();

      // If password is already set, validate old password
      if (hasPassword) {
        if (!oldPassword) {
          return {
            status: 400 as const,
            body: {
              status: 'error' as const,
              message: 'Current password is required',
              errors: ['Current password is required'],
            },
          };
        }

        // Validate old password (using legacy 6-character minimum for backward compatibility)
        if (oldPassword.length < 6) {
          return {
            status: 400 as const,
            body: {
              status: 'error' as const,
              message: 'Current password must be at least 6 characters',
              errors: ['Current password must be at least 6 characters'],
            },
          };
        }

        if (!userWithSecrets.isPasswordValid(oldPassword)) {
          return {
            status: 400 as const,
            body: {
              status: 'error' as const,
              message: 'Wrong current password',
              errors: ['Wrong current password'],
            },
          };
        }
      }

      // Update password
      return new Promise((resolve) => {
        userWithSecrets.updatePassword(newPassword, (err: Error | null) => {
          if (err) {
            debug('Error updating password:', err);
            const error = err as { errors?: Record<string, { message: string }> };
            const errorMessages: string[] = [];

            if (error.errors) {
              Object.keys(error.errors).forEach((e) => {
                errorMessages.push(error.errors![e].message);
              });
            } else {
              errorMessages.push('Failed to update password');
            }

            return resolve({
              status: 400 as const,
              body: {
                status: 'error' as const,
                message: errorMessages[0] || 'Failed to update password',
                errors: errorMessages,
              },
            });
          }

          return resolve({
            status: 200 as const,
            body: {
              status: 'ok' as const,
              message: 'Password updated',
            },
          });
        });
      });
    },

    getApiToken: async ({ req }) => {
      const user = req.user as UserDocument;

      try {
        // apiToken is select: false, so we need to populate it explicitly
        const userWithSecrets = await user.populateSecrets();
        const apiToken = userWithSecrets.apiToken;

        // If no API token exists yet, generate one
        if (!apiToken) {
          const updatedUser = await userWithSecrets.updateApiToken();
          return {
            status: 200 as const,
            body: {
              status: 'ok' as const,
              apiToken: updatedUser.apiToken,
            },
          };
        }

        return {
          status: 200 as const,
          body: {
            status: 'ok' as const,
            apiToken,
          },
        };
      } catch (err) {
        debug('Error getting API token:', err);
        return {
          status: 500 as const,
          body: {
            status: 'error' as const,
            message: 'Failed to get API token',
          },
        };
      }
    },

    resetApiToken: async ({ req }) => {
      const user = req.user as UserDocument;

      try {
        // apiToken is select: false, so we need to populate it explicitly
        const userWithSecrets = await user.populateSecrets();
        const updatedUser = await userWithSecrets.updateApiToken();

        return {
          status: 200 as const,
          body: {
            status: 'ok' as const,
            apiToken: updatedUser.apiToken,
          },
        };
      } catch (err) {
        debug('Error resetting API token:', err);
        return {
          status: 500 as const,
          body: {
            status: 'error' as const,
            message: 'Failed to update API token',
          },
        };
      }
    },
  });

  createExpressEndpoints(apiContract.me, meRouter, router);

  return router;
};
