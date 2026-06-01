import { Alert, AlertDescription } from '@/components/ui/alert';

interface FormErrorListProps {
  errors: string[];
}

/**
 * Destructive alert listing one or more form-submission errors as a bulleted
 * list. Renders nothing when `errors` is empty. Shared by the public auth
 * forms (login / register / reset-password / invite-accept) which all surface
 * a `string[]` of validation / server errors above the form.
 */
export function FormErrorList({ errors }: FormErrorListProps) {
  if (errors.length === 0) return null;

  return (
    <Alert variant="destructive" className="mb-4">
      <AlertDescription>
        <ul className="list-disc list-inside space-y-1">
          {errors.map((error, index) => (
            <li key={index}>{error}</li>
          ))}
        </ul>
      </AlertDescription>
    </Alert>
  );
}
