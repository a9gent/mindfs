## ADDED Requirements

### Requirement: Moss appearance mode
The application SHALL support an appearance mode value named `moss` for the eye-comfort green theme.

#### Scenario: Persist moss mode
- **WHEN** the user selects the moss appearance mode
- **THEN** the application stores `moss` as the selected appearance mode

#### Scenario: Apply moss theme attribute
- **WHEN** the selected appearance mode is `moss`
- **THEN** the document root uses `data-theme="moss"`

#### Scenario: Treat moss as light effective mode
- **WHEN** code asks for the effective appearance mode while `moss` is selected
- **THEN** the effective mode is `light` for components that only distinguish light and dark behavior

### Requirement: Moss theme menu option
The appearance settings UI SHALL present a selectable option labeled `苔痕绿影` for the moss theme.

#### Scenario: Show moss option
- **WHEN** the user opens the appearance mode selector
- **THEN** the selector includes an option labeled `苔痕绿影`

#### Scenario: Select moss option
- **WHEN** the user chooses `苔痕绿影`
- **THEN** the application switches to the `moss` appearance mode

### Requirement: Moss theme visual tokens
The moss theme SHALL define a complete set of CSS custom properties for the application surface using low-saturation green colors.

#### Scenario: Render moss palette
- **WHEN** the document root has `data-theme="moss"`
- **THEN** application backgrounds, text, borders, panels, accents, selection states, and code blocks use the moss theme token values

#### Scenario: Sync browser theme color
- **WHEN** the selected appearance mode is `moss`
- **THEN** the browser `theme-color` meta value is updated to the moss background color
